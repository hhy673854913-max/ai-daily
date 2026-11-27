# 架构与环境变量

> 面向后续迭代的工程文档：代码结构、数据流、环境变量、数据库集合、部署要点。
> RAG 问答的详细设计见 [RAG.md](./RAG.md)。

## 1. 系统全景

```
定时触发器 daily-0730 (cron: 0 30 7 * * * *, 7 段)
        │
        ▼
aiDailyCollect (Python 3.10, Event 函数, timeout=300, handler=index.main)
  流水线：resolve_sources → RSS 并发采集 → 前一日过滤 → AI 关键词过滤
        → 正文补抓(前 8 条) → 低质过滤 → SimHash 去重
        → LLM/启发式结构化抽取 → 类别补漏 → 综合排序
        → 类别兜底 Top 10 → 星级映射 → 渲染 Markdown
        │ HTTPS POST INGEST_URL (token 鉴权)
        ▼
aiDailyApi (Nodejs 18.15, Event 函数, timeout=60, handler=index.main)
  网关路由 /aiDailyApi ←── web/ 静态站（CORS 开放）
  POST mode=ingest       写入 ai_daily_news + ai_daily_briefs
  POST mode=sourceReport 信源质量上报 → ai_daily_sources 注册表维护
  GET  mode=sources      拉取注册表（采集函数决定本次抓哪些源）
  GET  mode=brief/days/top/默认分页   查询
  RAG: mode=ask / ragSync / ragStatus（详见 RAG.md）
  定时触发器 rag-sync-0750 (cron: 0 50 7 * * * *) → 增量嵌入向量库
        │
        ▼
云数据库（CloudBase）
  ai_daily_news        全量条目（按 urlHash 幂等去重）
  ai_daily_briefs      每日简报（按 day upsert）
  ai_daily_sources     信源注册表（质量分 / 正选轮换）
  ai_daily_rag_vectors RAG 向量库
```

关键设计：

- **采集端复用 Python 流水线**：`brief/` 模块移植自原 AI_brief 项目，仅把"磁盘落盘"改为 HTTP ingest 写库。
- **时区对齐**：SCF 容器默认 UTC，[index.py](file:///c:/space/ai-daily/functions/aiDailyCollect/index.py) 启动时强制 `TZ=Asia/Shanghai`，否则"前一日过滤"会错位。
- **LLM 全链路可选**：采集抽取与 RAG 问答均在未配置 LLM 密钥时自动降级（启发式抽取 / 摘录式回答），流水线不断。
- **ingest 幂等**：新闻按 `urlHash`（URL 的 SHA-1 前 16 位）判重，简报按 `day` upsert，重复触发安全。

## 2. 目录结构与模块职责

```
ai-daily/
├── cloudbaserc.json              # CloudBase 项目配置（envId / 函数 / 触发器）
├── web/                          # 前端（纯静态，无构建依赖）
│   ├── config.js                 # window.AI_DAILY_CONFIG.apiBase（网关地址）
│   ├── index.html
│   └── assets/{app.js, style.css}
├── docs/                         # 工程文档（本文件 / RAG.md）
└── functions/
    ├── aiDailyCollect/           # 每日采集（Python 3.10）
    │   ├── index.py              # 入口 main(event, context) → asyncio.run(run())
    │   │                         #   含 OpenAICompatClient（零依赖 LLM 客户端）
    │   │                         #   resolve_sources / item_to_doc / assign_stars / run
    │   ├── requirements.txt      # feedparser==6.0.11, pydantic==2.9.2
    │   ├── brief/                # 流水线模块
    │   │   ├── models.py         #   数据契约：RawItem / BriefItem / TrustedSource / PipelineReport
    │   │   ├── sources.py        #   RSS 并发采集、正文补抓、时效/AI/低质过滤
    │   │   ├── dedup.py          #   SimHash 去重
    │   │   ├── extract.py        #   LLM 抽取 + 启发式兜底 + 类别关键词猜测
    │   │   ├── prompts.py        #   抽取提示词 EXTRACT_PROMPT
    │   │   ├── core.py           #   排序（可信度0.7+时效0.3）、类别兜底 Top N、Markdown 渲染
    │   │   └── registry.py       #   信源注册表客户端：读池/选源/生成质量报告
    │   └── data/
    │       ├── trusted_sources.json  # 静态可信源（远端注册表不可用时的降级）
    │       └── source_pool.json      # 候选池（5 类约 20 源，注册表的输入）
    └── aiDailyApi/               # 查询/写入/RAG（Nodejs 18.15）
        ├── index.js              # 入口 exports.main：路由分发 + ingest + 信源注册表 + RAG 三个 handler
        ├── rag/                  # RAG 模块（详见 docs/RAG.md）
        │   ├── gate.js           #   三重门禁：认证 / 范围 / 拒答
        │   ├── embeddings.js     #   OpenAI 兼容嵌入，缺密钥降级 HashingEmbeddings(1024 维)
        │   ├── chunk.js          #   简报条目 → RAG 文档（docId = sha1(url) 前 16 位）
        │   ├── chain.js          #   LCEL 问答链 + 摘录式降级回答
        │   └── store.js          #   向量库：CloudBase 集合 ↔ MemoryVectorStore，10 分钟模块级缓存
        └── tests/rag.test.js     # RAG 单元测试（node --test）
```

### 流水线各环节速查（aiDailyCollect）

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| 选源 | `index.resolve_sources` + `brief/registry.select_sources` | 优先远端注册表（正选全部 + 每类 2 个候选试炼），失败退回 `trusted_sources.json` |
| 采集 | `brief/sources.fetch_all_trusted_sources` | ThreadPoolExecutor 并发 8，单源失败记 0 不阻断；带浏览器 UA + 12s 超时 |
| 时效过滤 | `filter_previous_day` | 只保留前一日 00:00–23:59:59（上海时区）；RSS 的 UTC 时间戳先换算到本地再过滤 |
| AI 过滤 | `filter_ai_related` | 标题+正文命中 `AI_KEYWORDS` 即保留 |
| 正文补抓 | `enrich_empty_content` | 云端串行很贵，只补最贫瘠的 `MAX_ENRICH=16` 条（RSS 摘录 <600 字视为缺正文），单条 5s 超时 |
| 低质过滤 | `filter_low_quality` | 标题党 / 正文剥标签后 <80 字 / 字符多样性 <20 / 标题正文重合 |
| 去重 | `brief/dedup.dedup` | SimHash |
| 抽取 | `brief/extract.extract_batch` | 并发 5；LLM 失败单条降级启发式；未配 LLM 全量启发式 |
| 类别补漏 | `index.run` 内 | 对「其他」条目用关键词重判，只补缺口的类别，每类补 1 条 |
| 排序 | `brief/core.rank` | `score = credibility*0.7 + freshness(48h 线性衰减)*100*0.3` |
| 精选 | `core.pick_top_with_coverage` | 每类兜底 1 条再按分补齐 Top 10；论文类（arXiv/Nature）每日封顶 `PAPER_TOP_N=3` 条 |
| 星级 | `index.assign_stars` | 入选条目按分数线性映射 [2.5, 5]，四舍五入半星 |
| 写入 | `index.post_ingest` | POST INGEST_URL，brief 整体 upsert |
| 信源上报 | `registry.build_source_reports` | `run_score = 0.5*可信度均值 + 0.35*产出分 + 0.15*可达分`；可达但今日无稿给产出保底分（不算不佳），失败不影响主流程 |

### 信源注册表（ai_daily_sources，动态信源管理）

- 状态存云端集合，采集端每次运行：拉注册表 → 选源 → 采集 → 上报 `sourceReport`。
- API 侧 `handleSourceReport`：新源按 tier 基线入库为 candidate → EMA 更新质量分（`0.5*runScore + 0.5*旧值`）→ 连续 3 次 `runScore < 35` 标记 removed → 类别内按质量分重排，前 3 名转正选（active）。
- 剔除不是终局：仍在候选池中的 removed 源，距上次运行满 7 天自动恢复为 candidate 重新试炼（RSS 故障多为暂时性，防止中文源集体消失导致覆盖面塌缩）。
- 采集池（source_pool.json）中已不存在的源 = 编辑决策移除，直接标记 removed。
- 常量：每类正选 3（合计 ≤15）、每类试炼 2、tier 基线 `{官方公告:75, 权威媒体:65, 垂直媒体:55, 自媒体:35}`。

## 3. 环境变量总表

### aiDailyCollect（Python 采集函数）

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `INGEST_URL` | 是 | API 函数网关地址（POST 写入 + GET `?mode=sources` 共用此地址） |
| `INGEST_TOKEN` | 是 | 写入鉴权令牌，与 aiDailyApi 的 `INGEST_TOKEN` 必须一致 |
| `LLM_API_KEY` | 否 | 配置后启用 LLM 结构化抽取；与 `LLM_BASE_URL` 同时存在才生效 |
| `LLM_BASE_URL` | 否 | OpenAI 兼容接口地址（`/chat/completions` 由代码拼接） |
| `LLM_MODEL` | 否 | 缺省 `gpt-4o-mini` |

### aiDailyApi（Node 接口函数）

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `INGEST_TOKEN` | 是 | ingest / sourceReport / ragSync 的共用鉴权令牌 |
| `RAG_ACCESS` | RAG 必需 | RAG 问答令牌注册表（JSON 字符串），未配置 = 问答与 ragStatus 全部 403。格式：`{"tokens":{"<token>":{"user":"alice","categories":["融资","技术"]}}}`；`categories` 缺省/为空 = 全部分类 |
| `LLM_API_KEY` | 否 | 问答生成；未配置时降级为摘录式回答 |
| `LLM_BASE_URL` | 否 | OpenAI 兼容接口地址 |
| `LLM_MODEL` | 否 | 缺省 `gpt-4o-mini` |
| `EMBEDDING_API_KEY` | 否 | 嵌入密钥；缺省回退用 `LLM_API_KEY`；都没有 = 内置 hashing-v2 |
| `EMBEDDING_BASE_URL` | 否 | 嵌入接口地址；缺省回退 `LLM_BASE_URL` |
| `EMBEDDING_MODEL` | 否 | 缺省 `text-embedding-3-small` |
| `EMBEDDING_DIMENSIONS` | 否 | 部分服务（如 DashScope 兼容模式）要求显式维度，如 `1024` |
| `RAG_MIN_SCORE` | 否 | 拒答相关性阈值；缺省 hashing 0.18 / OpenAI 0.35 |

### 代码内常量（改行为需改代码）

| 常量 | 位置 | 值 | 说明 |
| --- | --- | --- | --- |
| `TOP_N` | collect/index.py | 10 | 每日精选条数 |
| `MAX_ENRICH` | collect/index.py | 16 | 正文补抓条数上限（按内容贫瘠度选条，非按列表位置） |
| `STAR_MIN/MAX` | collect/index.py | 2.5 / 5.0 | 星级映射区间 |
| `RAG_TOP_K` | api/index.js | 6 | 问答检索条数 |
| `EMBED_BATCH` | api/index.js | 10 | 嵌入批大小 |
| `ACTIVE_PER_CATEGORY` | api/index.js / registry.py | 3 | 每类正选上限 |
| `TRIAL_PER_CATEGORY` | registry.py | 2 | 每类试炼候选数 |
| `BAD_STRIKE_LIMIT` | api/index.js / registry.py | 3 | 连续质量不佳剔除阈值 |
| `BAD_RUN_THRESHOLD` | registry.py | 35.0 | run_score 低于此记一次不佳 |
| `CACHE_TTL` | rag/store.js | 10 min | 向量库模块级缓存 |

### 前端

- [web/config.js](file:///c:/space/ai-daily/web/config.js)：`window.AI_DAILY_CONFIG.apiBase`，部署后指向 `https://<envId>-<appid>.ap-shanghai.app.tcloudbase.com`。

## 4. 数据库集合

### ai_daily_news（全量条目）

ingest 时按 `urlHash` 幂等去重写入。字段：`id / title / summary / url / urlHash / source / sourceId / lang(zh|en) / kind(news|paper) / category / entities[] / credibility / score / stars / analysis / snark / publishedAt / collectedAt / day`。由 collect 的 `item_to_doc` 生成。

### ai_daily_briefs（每日简报，按 day upsert）

| 字段 | 说明 |
| --- | --- |
| `day` | 采集日 `YYYY-MM-DD`（Asia/Shanghai） |
| `items` | 精选 10 条（结构同上） |
| `markdown` | 简报 Markdown（含星级文本） |
| `report` | PipelineReport：各环节数量、平均可信度、耗时、失败明细 |
| `createdAt` | 写入时间 ms |

### ai_daily_sources（信源注册表）

`name / rss / category / tier / status(active|candidate|removed) / quality(EMA 质量分) / runs / consecutiveBad / lastRunScore / lastRunAt / updatedAt`

### ai_daily_rag_vectors（RAG 向量库）

`docId / day / title / text / category / url / source / stars / lang / model / dim / embedding(number[]) / updatedAt`。详见 [RAG.md](./RAG.md)。

## 5. API 一览

`GET/POST https://<envId>-<appid>.ap-shanghai.app.tcloudbase.com/aiDailyApi`，全部响应 `{ ok, data | error }`，CORS 开放，GET 缓存 60s。

| 模式 | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| （默认） | GET | 无 | 分页查询条目：`day / lang / kind / source / category / page / pageSize(≤100)`，按 score 降序 |
| `mode=top` | GET | 无 | 当日综合分 Top 5 |
| `mode=brief&day=` | GET | 无 | 某日简报（markdown + items + report） |
| `mode=days` | GET | 无 | 有简报的日期列表（最多 365 条） |
| `mode=sources` | GET | 无 | 信源注册表（正选在前，按质量降序） |
| `mode=ask` | GET/POST | RAG 令牌 | 简报问答，令牌优先放 `X-Rag-Token` 头 |
| `mode=ragStatus` | GET | RAG 令牌 | 向量库统计（总数/覆盖日期/模型） |
| `mode=ingest` | POST | INGEST_TOKEN | 采集写入（body: `{token, day, items, brief}`） |
| `mode=sourceReport` | POST | INGEST_TOKEN | 信源质量上报 + 候选池同步 |
| `mode=ragSync` | POST | INGEST_TOKEN | 历史简报增量嵌入（亦由 07:50 定时触发器执行） |

注意 POST 分发顺序：`sourceReport` / `ragSync` / `ask` 显式匹配后，**任何带 `token` 的 body 都会落入 ingest 分支**。

## 6. 部署与运维要点

- 函数与触发器定义在 [cloudbaserc.json](file:///c:/space/ai-daily/cloudbaserc.json)；采集 07:30、向量同步 07:50（7 段 cron）。
- aiDailyApi 依赖需 `npm install --legacy-peer-deps` 后随目录打包上传。
- aiDailyCollect 的 Python 依赖需预下载 manylinux wheels 解包到函数根目录（云端不自动装 requirements.txt），命令见 README「部署」一节。
- 首次启用 RAG 需手动跑一次全量 `ragSync`。
- 嵌入模型切换时 ragSync 检测到向量空间不一致会自动清空重建（`clearVectors`）。
- 本地调试：
  - 前端：`cd web && npx serve .`
  - 流水线：`cd functions/aiDailyCollect && pip install -r requirements.txt`，然后 `python -c "import asyncio, index; print(asyncio.run(index.run()))"`（需 INGEST_URL/TOKEN）
  - RAG 测试：`cd functions/aiDailyApi && node --test tests/rag.test.js`

## 7. 常见迭代入口

| 需求 | 改动位置 |
| --- | --- |
| 增删信源 | 编辑 `data/source_pool.json`（候选池）；静态降级列表 `data/trusted_sources.json` |
| 调整精选条数/星级区间 | `collect/index.py` 的 `TOP_N` / `STAR_MIN, STAR_MAX` |
| 调整排序权重 | `brief/core.py` 的 `rank`（可信度 0.7 / 时效 0.3） |
| 新增分类 | `models.Category`、`extract.CATEGORY_KEYWORDS`、`registry.CATEGORIES`、`api/index.js` 的 `CATEGORIES` 与 `gate.DEFAULT_CATEGORIES`（前后端共 5 处需同步） |
| 更换 LLM/嵌入服务商 | 只改环境变量；注意嵌入模型切换会触发向量库重建 |
| 调整 RAG 门禁策略 | `rag/gate.js` + `RAG_MIN_SCORE` 环境变量 |
| 前端展示 | `web/assets/app.js` / `style.css`，API 地址在 `web/config.js` |
