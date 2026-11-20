"""排序与简报渲染（从用户 AI_brief/pipeline.py 原样抽取，去掉磁盘落盘部分）。"""

from __future__ import annotations

from datetime import datetime

from .models import BriefItem, PipelineReport


def freshness_score(item: BriefItem, now: datetime) -> float:
    """48 小时线性衰减：越新分越高。"""
    if item.published_at is None:
        return 0.3
    published = item.published_at
    if published.tzinfo is not None:
        published = published.astimezone().replace(tzinfo=None)
    hours = max(0.0, (now - published).total_seconds() / 3600)
    return max(0.0, 1 - hours / 48)


def rank(items: list[BriefItem], now: datetime) -> list[BriefItem]:
    for item in items:
        item.score = round(item.credibility * 0.7 + freshness_score(item, now) * 100 * 0.3, 2)
    return sorted(items, key=lambda i: i.score, reverse=True)


def pick_top_with_coverage(
    ranked: list[BriefItem], top_n: int, categories: tuple[str, ...]
) -> list[BriefItem]:
    """精选 top_n，且每个类别至少兜底 1 条（类别无货时自然跳过）。

    先按排名为每个类别取第 1 条，再按分数补齐剩余名额，最终结果保持分数降序。
    """
    by_cat: dict[str, list[BriefItem]] = {}
    for it in ranked:
        by_cat.setdefault(it.category, []).append(it)

    picked: list[BriefItem] = []
    picked_ids: set[int] = set()
    for cat in categories:
        group = by_cat.get(cat)
        if group:
            picked.append(group[0])
            picked_ids.add(id(group[0]))
    for it in ranked:
        if len(picked) >= top_n:
            break
        if id(it) not in picked_ids:
            picked.append(it)
            picked_ids.add(id(it))
    return sorted(picked, key=lambda i: i.score, reverse=True)


def format_stars(stars: float) -> str:
    """星级文本：★ 实心、⯪ 半星、☆ 空心，如 ★★★★⯪。"""
    full = int(stars)
    half = 1 if stars - full >= 0.5 else 0
    return "★" * full + ("⯪" if half else "") + "☆" * (5 - full - half)


def render_markdown(items: list[BriefItem], report: PipelineReport) -> str:
    lines = [
        f"# 智能资讯简报 · {report.date}",
        "",
        f"> 采集 {report.fetched} 条 → 前一日过滤后 {report.after_time_filter} 条"
        f" → AI 过滤后 {report.after_ai_filter} 条 → 正文增强后 {report.after_content_filter} 条"
        f" → 去重后 {report.after_dedup} 条"
        f" → 成功抽取 {report.extracted_ok} 条（失败 {report.failed}）｜平均可信度 {report.avg_credibility:.1f}",
        "",
    ]
    by_category: dict[str, list[BriefItem]] = {}
    for item in items:
        by_category.setdefault(item.category, []).append(item)

    for category, group in by_category.items():
        lines.append(f"## {category}")
        for i, item in enumerate(group, 1):
            when = f" · {item.published_at:%m-%d}" if item.published_at else ""
            stars = f" · {format_stars(item.stars)} {item.stars}" if item.stars else ""
            lines.append(f"### {i}. {item.title}")
            lines.append(f"`{item.source}`{when} · 可信度 **{item.credibility}**{stars}")
            lines.append("")
            lines.append(item.summary)
            if item.entities:
                lines.append("")
                lines.append("标签：" + " ".join(f"`{e}`" for e in item.entities))
            lines.append("")
            lines.append(f"[原文]({item.url})")
            lines.append("")
    return "\n".join(lines)
