"""结构化抽取：LLM 版 + 离线启发式版。

移植自用户 AI_brief/extract.py，仅改动：
- client_parse 不再依赖 code.shared.structured，内置宽松 JSON 解析
- 其余规则与降级策略保持不变
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from .models import BriefItem, Category, RawItem
from .prompts import EXTRACT_PROMPT

log = logging.getLogger("brief.extract")

# 信源等级 → 权威性得分（可信度评分的第一个维度）
SOURCE_TIER = {
    "官方公告": 40,
    "36氪": 30,
    "机器之心": 30,
    "量子位": 30,
    "GameLook": 20,
    "自媒体": 10,
}

CATEGORY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "融资": ("融资", "估值", "轮", "投资", "IPO", "辞职", "复职", "离职", "董事会", "高管"),
    "产品": ("发布", "上线", "更新", "版本", "功能"),
    "政策": ("政策", "监管", "备案", "法规", "标准"),
    "技术": ("模型", "开源", "论文", "算法", "架构", "Agent", "RAG"),
}

# 信源等级 → credibility 下限：LLM 面对信息量有限的摘要时容易给出偏低的
# 「内容分」，把权威信源报道的真新闻压成「不可信」。下限保证分数反映
# 信源底线，而不是摘要的残缺程度。
TIER_FLOOR = {"官方公告": 40, "权威媒体": 30, "垂直媒体": 20, "自媒体": 10}

_TIER_BY_NAME: tuple[tuple[str, str], ...] = (
    ("OpenAI", "官方公告"), ("Anthropic", "官方公告"), ("arXiv", "官方公告"),
    ("DeepMind", "官方公告"), ("Hugging Face", "官方公告"), ("Meta AI", "官方公告"),
    ("NVIDIA", "官方公告"),
    ("TechCrunch", "权威媒体"), ("The Verge", "权威媒体"), ("WIRED", "权威媒体"),
    ("VentureBeat", "权威媒体"), ("Crunchbase", "权威媒体"), ("MIT", "权威媒体"),
    ("Ars Technica", "权威媒体"), ("Nature", "权威媒体"), ("InfoQ", "权威媒体"),
    ("36氪", "权威媒体"),
    ("机器之心", "垂直媒体"), ("量子位", "垂直媒体"), ("The Decoder", "垂直媒体"),
    ("少数派", "垂直媒体"), ("爱范儿", "垂直媒体"), ("极客公园", "垂直媒体"),
)


def tier_floor(source_name: str) -> int:
    for key, tier in _TIER_BY_NAME:
        if key in source_name:
            return TIER_FLOOR[tier]
    return TIER_FLOOR["自媒体"]


def guess_category(text: str) -> Category:
    best, best_hits = "其他", 0
    for cat, words in CATEGORY_KEYWORDS.items():
        hits = sum(text.count(w) for w in words)
        if hits > best_hits:
            best, best_hits = cat, hits
    return best  # type: ignore[return-value]


def first_sentence(text: str, limit: int = 80) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    return cleaned[:limit]


def heuristic_extract(raw: RawItem) -> BriefItem:
    """没有模型时的兜底：规则版抽取。"""
    text = f"{raw.title}\n{raw.content}"
    authority = next((v for k, v in SOURCE_TIER.items() if k in raw.source), 20)
    specific = min(30, 10 + 10 * sum(bool(re.search(p, text)) for p in (r"\d+%?", r"\d+亿", r"\d{4}年")))
    verifiable = 20 if re.search(r"\d", text) else 10
    credibility = min(100, authority + verifiable + specific)
    if specific >= 20:
        detail_note = "内容包含具体数据和细节，信息比较扎实"
    elif verifiable >= 20:
        detail_note = "内容有一定事实支撑，但细节一般"
    else:
        detail_note = "内容比较笼统，缺少可核实的细节"
    analysis = f"这条资讯来自{raw.source}，{detail_note}。综合信源权威性、可验证性和具体性，给出可信度 {credibility} 分。"
    return BriefItem.from_raw(
        raw,
        title=raw.title.strip(),
        summary=first_sentence(raw.content),
        category=guess_category(text),
        entities=re.findall(r"[A-Z][A-Za-z]{2,}", text)[:5],
        credibility=credibility,
        analysis=analysis,
        snark=2,  # 兜底点评给温和档
    )


def llm_extract(client: Any, raw: RawItem, *, max_tokens: int = 700) -> BriefItem:
    """LLM 抽取；失败时抛出，由批量层决定降级策略。"""
    text = raw.content.strip() or raw.title.strip()
    prompt = EXTRACT_PROMPT.format(text=text[:2000])
    result = client.chat(
        [{"role": "user", "content": prompt}],
        temperature=0,
        max_tokens=max_tokens,
        response_format={"type": "json_object"},
    )
    parsed = client_parse(result.content)
    # 入库保留完整标题，展示截断交给前端/CSS
    title = str(parsed.get("title") or raw.title).strip()
    # 可信度稳定性融合：LLM（qwen 系）对同一事件的评分跨轮方差极大
    # （黄仁勋复职同一素材 20~65 都出现过），且偏爱苛责细节残缺的真新闻。
    # 规则分作为柔和下限参与融合：final = max(LLM分, min(规则分, 50))，
    # 真新闻不会被压到信源底线以下，LLM 的高分判断也仍然有效。
    llm_cred = max(int(parsed.get("credibility") or 30), tier_floor(raw.source))
    heuristic_cred = heuristic_extract(raw).credibility
    return BriefItem.from_raw(
        raw,
        title=title,
        summary=str(parsed.get("summary") or "").strip()[:120],
        category=parsed.get("category") if parsed.get("category") in CATEGORY_KEYWORDS else "其他",
        entities=[str(x) for x in (parsed.get("entities") or [])][:8],
        credibility=max(llm_cred, min(heuristic_cred, 50)),
        analysis=str(parsed.get("analysis") or "").strip()[:300],
        snark=max(0, min(5, int(parsed.get("snark") or 0))),
    )


def extract_json(raw: str) -> str:
    """从模型输出中截取第一个 JSON 对象（容错前缀/后缀废话）。"""
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return raw
    return raw[start : end + 1]


def loads_lenient(raw: str) -> dict[str, Any]:
    """宽松解析：先去 Markdown 代码块标记，再尝试修复尾随逗号。"""
    text = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        fixed = re.sub(r",(\s*[}\]])", r"\1", text)
        return json.loads(fixed)


def client_parse(raw: str) -> dict[str, Any]:
    return loads_lenient(extract_json(raw))


async def extract_batch(
    items: list[RawItem],
    client: Any | None,
    *,
    concurrency: int = 5,
    use_llm: bool = True,
) -> tuple[list[BriefItem], list[dict]]:
    """并发抽取；单条失败不中断整批，并记录失败原因。"""
    sem = asyncio.Semaphore(concurrency)
    ok: list[BriefItem] = []
    failed: list[dict] = []

    async def one(raw: RawItem) -> None:
        async with sem:
            if not use_llm or client is None:
                ok.append(heuristic_extract(raw))
                return
            try:
                ok.append(await asyncio.to_thread(llm_extract, client, raw))
            except Exception as exc:  # noqa: BLE001 - 单条失败要隔离
                log.warning("抽取失败 %s: %s", raw.url, exc)
                failed.append({"id": raw.id, "url": raw.url, "error": f"{type(exc).__name__}: {exc}"})
                ok.append(heuristic_extract(raw))  # 降级而不是丢弃

    await asyncio.gather(*(one(i) for i in items))
    return ok, failed
