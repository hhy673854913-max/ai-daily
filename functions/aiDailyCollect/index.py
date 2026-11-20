"""aiDailyCollect —— CloudBase 云函数入口（每日 07:30 定时触发）。

基于既有 AI_brief 流水线（sources / dedup / extract / core），
产物不再落盘，而是通过 HTTP ingest 写入 Node API 函数 → 云数据库。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

# SCF 容器默认 UTC；流水线按“前一日”过滤，必须对齐到上海时区
os.environ["TZ"] = "Asia/Shanghai"
time.tzset()

sys.path.insert(0, str(Path(__file__).resolve().parent))

from brief.core import pick_top_with_coverage, rank, render_markdown  # noqa: E402
from brief.dedup import dedup  # noqa: E402
from brief.extract import extract_batch, guess_category  # noqa: E402
from brief.models import PipelineReport  # noqa: E402
from brief import registry  # noqa: E402
from brief.sources import (  # noqa: E402
    enrich_empty_content,
    fetch_all_trusted_sources,
    filter_ai_related,
    filter_low_quality,
    filter_previous_day,
    load_trusted_sources,
)

INGEST_URL = os.environ.get("INGEST_URL", "")
INGEST_TOKEN = os.environ.get("INGEST_TOKEN", "")
MAX_ENRICH = 8  # 串行抓正文很贵，云端只补前 N 条
TOP_N = 10      # 每日精选条数
STAR_MIN, STAR_MAX = 2.5, 5.0  # 入选即有价值：星级区间 [2.5, 5]，半星颗粒度


# ---------------- LLM 客户端（可选，OpenAI 兼容接口） ----------------
class _LLMResult:
    def __init__(self, content: str):
        self.content = content


class OpenAICompatClient:
    """对齐原 code.shared.llm_client 的 chat() 接口，无任何第三方依赖。"""

    def __init__(self) -> None:
        self.base = os.environ["LLM_BASE_URL"].rstrip("/")
        self.key = os.environ["LLM_API_KEY"]
        self.model = os.environ.get("LLM_MODEL", "gpt-4o-mini")

    def chat(self, messages, temperature=0, max_tokens=500, response_format=None):
        body = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format:
            body["response_format"] = response_format
        req = urllib.request.Request(
            f"{self.base}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.key}",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return _LLMResult(data["choices"][0]["message"]["content"])


def get_llm_client():
    """未配置 LLM 环境变量时返回 None，流水线自动降级为启发式抽取。"""
    if os.environ.get("LLM_API_KEY") and os.environ.get("LLM_BASE_URL"):
        return OpenAICompatClient()
    return None


# ---------------- 写入后端 ----------------
def post_ingest(payload: dict) -> dict:
    req = urllib.request.Request(
        INGEST_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_json(url: str, timeout: int = 15) -> dict:
    """GET JSON（带总体容错，调用方自行决定降级策略）。"""
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def resolve_sources() -> tuple[list, list]:
    """返回 (本次要抓的信源, 候选池)。

    优先用远端注册表（ai_daily_sources，按最近质量排序、每类正选 3 + 试炼 2）；
    远端不可用或为空时退回静态 trusted_sources.json，保证流水线不断。
    """
    pool = registry.load_source_pool()
    remote = []
    try:
        data = get_json(f"{INGEST_URL}?mode=sources")
        remote = (data.get("data") or {}).get("sources") or []
    except Exception:
        remote = []
    if remote:
        picked, _ = registry.select_sources(pool, remote)
        return picked, pool
    return load_trusted_sources(), pool


SOURCE_ID = {
    "机器之心": "jiqizhixin",
    "量子位": "qbitai",
    "36氪": "36kr",
    "InfoQ 中文": "infoq",
    "TechCrunch AI": "techcrunch",
    "The Verge AI": "theverge",
    "arXiv cs.AI/LG/CL": "arxiv",
}


def item_to_doc(item, day: str) -> dict:
    published_ms = int(item.published_at.timestamp() * 1000) if item.published_at else int(time.time() * 1000)
    text = f"{item.title} {item.summary}"
    lang = "zh" if any("一" <= ch <= "鿿" for ch in text) else "en"
    source_id = SOURCE_ID.get(item.source, "")
    return {
        "id": item.id,
        "title": item.title,
        "summary": item.summary,
        "url": item.url,
        "urlHash": item.id,
        "source": item.source,
        "sourceId": source_id,
        "lang": lang,
        "kind": "paper" if source_id == "arxiv" else "news",
        "category": item.category,
        "entities": item.entities,
        "credibility": item.credibility,
        "score": item.score,
        "stars": item.stars,
        "analysis": item.analysis,
        "snark": item.snark,
        "publishedAt": published_ms,
        "collectedAt": int(time.time() * 1000),
        "day": day,
    }


def assign_stars(items) -> None:
    """资深编辑视角：入选条目按综合分线性映射到 [2.5, 5]，半星颗粒度。"""
    if not items:
        return
    scores = [i.score for i in items]
    lo, hi = min(scores), max(scores)
    for it in items:
        norm = 1.0 if hi == lo else (it.score - lo) / (hi - lo)
        it.stars = round((STAR_MIN + norm * (STAR_MAX - STAR_MIN)) * 2) / 2


# ---------------- 主流程 ----------------
async def run() -> dict:
    from datetime import datetime

    t0 = time.perf_counter()
    now = datetime.now()

    sources, pool = resolve_sources()
    fetch_stats: dict[str, int] = {}
    raw_items = fetch_all_trusted_sources(sources, limit=30, stats=fetch_stats)
    fetched = len(raw_items)

    time_filtered = filter_previous_day(raw_items, now)
    ai_filtered, _ = filter_ai_related(time_filtered)
    # 云端串行抓正文有超时风险，只补前 N 条、缩短单条超时
    head, tail = ai_filtered[:MAX_ENRICH], ai_filtered[MAX_ENRICH:]
    enriched, _, _ = enrich_empty_content(head, timeout_s=5)
    quality_filtered, _, _ = filter_low_quality(enriched + tail)

    payload = [{"url": r.url, "title": r.title, "content": r.content} for r in quality_filtered]
    kept, _ = dedup(payload)
    kept_urls = {k["url"] for k in kept}
    deduped = [r for r in quality_filtered if r.url in kept_urls]

    client = get_llm_client()
    brief_items, failed = await extract_batch(deduped, client, use_llm=client is not None)
    # 类别补漏：LLM 倾向把政策/融资类资讯误归「其他」，导致某类空缺。
    # 对「其他」条目用启发式关键词重判，只补缺的那几类，每类补 1 条即止。
    missing = [c for c in registry.CATEGORIES if c not in {it.category for it in brief_items}]
    if missing:
        for it in brief_items:
            if it.category == "其他":
                guessed = guess_category(f"{it.title} {it.summary}")
                if guessed in missing:
                    it.category = guessed
                    missing.remove(guessed)
                    if not missing:
                        break
    ranked = rank(brief_items, now)
    # 每个类别至少兜底 1 条，再按分数补齐
    picked = pick_top_with_coverage(ranked, TOP_N, registry.CATEGORIES)
    assign_stars(picked)

    day = now.strftime("%Y-%m-%d")
    report = PipelineReport(
        date=day,
        sources=len({r.source for r in raw_items}),
        fetched=fetched,
        after_time_filter=len(time_filtered),
        after_ai_filter=len(ai_filtered),
        after_content_filter=len(quality_filtered),
        after_dedup=len(deduped),
        extracted_ok=len(brief_items) - len(failed),
        failed=len(failed),
        avg_credibility=round(sum(i.credibility for i in brief_items) / max(len(brief_items), 1), 1),
        duration_s=round(time.perf_counter() - t0, 2),
        failed_items=failed,
    )
    markdown = render_markdown(picked, report)

    result = post_ingest(
        {
            "token": INGEST_TOKEN,
            "day": day,
            "brief": {
                "day": day,
                "items": [item_to_doc(i, day) for i in picked],
                "markdown": markdown,
                "report": json.loads(report.model_dump_json()),
                "createdAt": int(time.time() * 1000),
            },
        }
    )

    # 信源质量上报（失败不影响主流程，下次运行时注册表维持原样）
    source_report_result = {"ok": False}
    try:
        body = registry.build_source_reports(pool, fetch_stats, deduped, brief_items)
        body.update({"token": INGEST_TOKEN, "mode": "sourceReport"})
        source_report_result = post_ingest(body)
    except Exception as exc:  # noqa: BLE001
        source_report_result = {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "day": day,
        "picked": len(picked),
        "ingest": result,
        "sourceReport": source_report_result,
    }


def main(event, context):
    return asyncio.run(run())
