"""信源注册表：动态信源管理（质量评估 / 类别内排序 / 正选轮换 / 末位剔除）。

设计：
- 函数包内置 data/source_pool.json 为「候选池」（5 类 × 若干，共约 20 个），
  真正的运行状态（quality/runs/consecutive_bad/status）存在云数据库 ai_daily_sources，
  由 aiDailyApi 维护；本模块只负责：
  1) 读池 + 拉远端注册表 → 决定本次抓哪些源（正选全部 + 每类 2 个候选试炼）；
  2) 本轮结束后按各源表现算 run_score，连同池信息一起上报给 API 更新注册表。
"""

from __future__ import annotations

import json
from pathlib import Path

from .models import BriefItem, RawItem, TrustedSource

POOL_PATH = Path(__file__).resolve().parent.parent / "data" / "source_pool.json"

CATEGORIES: tuple[str, ...] = ("融资", "产品", "政策", "技术", "其他")
ACTIVE_PER_CATEGORY = 3       # 每类正选上限（合计最多 15 个）
TRIAL_PER_CATEGORY = 2        # 每类每次额外试炼的候选数
BAD_RUN_THRESHOLD = 35.0      # run_score 低于此值记一次质量不佳
BAD_STRIKE_LIMIT = 3          # 连续质量不佳次数上限，超过剔除

TIER_BASELINE = {"官方公告": 75.0, "权威媒体": 65.0, "垂直媒体": 55.0, "自媒体": 35.0}


def load_source_pool(path: Path | None = None) -> list[TrustedSource]:
    """加载内置候选池。"""
    p = path or POOL_PATH
    rows = json.loads(p.read_text(encoding="utf-8"))
    return [TrustedSource.model_validate(r) for r in rows]


def select_sources(
    pool: list[TrustedSource], remote: list[dict] | None
) -> tuple[list[TrustedSource], list[TrustedSource]]:
    """根据远端注册表状态选出本次要抓的源。

    返回 (正选+试炼列表, 全部被选中源)。remote 为空（首次运行/接口故障）时
    退化为按 tier 基线每类取前 3。
    """
    by_name = {s.name: s for s in pool}
    if not remote:
        picked: list[TrustedSource] = []
        for cat in CATEGORIES:
            cat_pool = [s for s in pool if s.category == cat]
            cat_pool.sort(key=lambda s: -TIER_BASELINE.get(s.tier, 50))
            picked.extend(cat_pool[:ACTIVE_PER_CATEGORY])
        return picked, picked

    # 远端注册表：status in active/candidate（removed 已被 API 过滤）
    active, candidates = [], []
    for row in remote:
        src = by_name.get(row.get("name"))
        if src is None:
            continue
        if row.get("status") == "active":
            active.append((row.get("quality") or 0, src))
        else:
            candidates.append((row.get("quality") or 0, src))
    active_srcs = [s for _, s in active]

    # 每类补试炼候选（质量高的优先试炼）
    trial: list[TrustedSource] = []
    for cat in CATEGORIES:
        cat_cand = sorted(
            ((q, s) for q, s in candidates if s.category == cat),
            key=lambda x: -x[0],
        )
        trial.extend(s for _, s in cat_cand[:TRIAL_PER_CATEGORY])

    picked = active_srcs + [s for s in trial if s not in active_srcs]
    return picked, picked


def build_source_reports(
    pool: list[TrustedSource],
    fetch_stats: dict[str, int],
    kept: list[RawItem],
    extracted: list[BriefItem],
) -> list[dict]:
    """按本轮表现为每个被抓取的源生成质量报告。

    kept: 通过时效+AI+质量过滤的条目；extracted: 成功抽取的条目。
    run_score = 0.5*可信度均值 + 0.35*产出分 + 0.15*可达分
    """
    meta = {s.name: {"rss": s.rss, "category": s.category, "tier": s.tier} for s in pool}
    passed_by_source: dict[str, int] = {}
    for it in kept:
        passed_by_source[it.source] = passed_by_source.get(it.source, 0) + 1
    cred_by_source: dict[str, list[int]] = {}
    for it in extracted:
        cred_by_source.setdefault(it.source, []).append(it.credibility)

    reports = []
    for name, fetched in fetch_stats.items():
        creds = cred_by_source.get(name, [])
        cred = sum(creds) / len(creds) if creds else 30.0
        passed = passed_by_source.get(name, 0)
        yield_score = min(100.0, 35.0 * passed)
        reachable = 15.0 if fetched > 0 else 0.0
        run_score = round(0.5 * cred + 0.35 * yield_score + reachable, 1)
        reports.append(
            {
                "name": name,
                "fetched": fetched,
                "passed": passed,
                "avgCredibility": round(cred, 1),
                "runScore": run_score,
                "bad": run_score < BAD_RUN_THRESHOLD,
            }
        )
    # 池信息随报告带上，便于 API 侧补充新源（rss/category/tier）
    pool_info = [
        {"name": s.name, "rss": s.rss, "category": s.category, "tier": s.tier} for s in pool
    ]
    return {"reports": reports, "pool": pool_info}
