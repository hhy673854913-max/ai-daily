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

from brief.core import rank, render_markdown  # noqa: E402
from brief.dedup import dedup  # noqa: E402
from brief.extract import extract_batch  # noqa: E402
from brief.models import PipelineReport  # noqa: E402
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

    trusted_sources = load_trusted_sources()
    raw_items = fetch_all_trusted_sources(trusted_sources, limit=30)
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
    ranked = rank(brief_items, now)
    picked = ranked[:TOP_N]
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
    return {"ok": True, "day": day, "picked": len(picked), "ingest": result}


def main(event, context):
    return asyncio.run(run())
