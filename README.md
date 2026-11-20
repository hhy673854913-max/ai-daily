# AI 日报 · The AI Gazette

每日自动采集全网 AI 资讯的聚合站点。每天 07:30（Asia/Shanghai）由腾讯云 CloudBase 定时云函数驱动，基于 `AI_brief` 流水线（RSS 采集 → 时效过滤 → AI 相关性过滤 → SimHash 去重 → 结构化抽取 → 可信度评分）产出资讯流与每日简报。

线上地址：https://ai-daily-florist-prod-d4gtxxh7s9a071ff0.webapps.tcloudbase.com

## 数据源

| 来源 | 类型 | 语言 |
| --- | --- | --- |
| 机器之心 | 新闻 | 中文 |
| 量子位 | 新闻 | 中文 |
| 36氪 | 新闻 | 中文 |
| InfoQ 中文 | 新闻 | 中文 |
| TechCrunch AI | 新闻 | EN |
| The Verge AI | 新闻 | EN |
| arXiv (cs.AI / cs.LG / cs.CL) | 论文 | EN |

信源配置：`functions/aiDailyCollect/data/trusted_sources.json`（`enabled: false` 可停用某个源）。

## 架构

```
定时触发器 (7 段 cron: 0 30 7 * * * *)
        │
        ▼
aiDailyCollect (Python3.10, Event 函数)
  AI_brief 流水线：feedparser 多源采集
  → 前一日过滤 → AI 关键词过滤 → 低质过滤
  → SimHash 去重 → 启发式/LLM 结构化抽取
  → 可信度评分 + 时效综合排序
        │ HTTPS POST (INGEST_TOKEN 鉴权)
        ▼
aiDailyApi (Nodejs18.15, Event 函数)  ←── 网关路由 /aiDailyApi
  mode=ingest 写入 / 查询：list、days、top、brief
        │
        ▼
  云数据库 ai_daily_news / ai_daily_briefs
        ▲
        │ HTTPS (CORS 开放)
  web/ 静态站点（CloudBase 静态托管，独立子域名）
```

设计要点：

- **采集端复用 Python 流水线**：`functions/aiDailyCollect/brief/` 下的 `sources / dedup / extract / prompts / core` 模块直接移植自原项目，仅把"磁盘落盘"改为"HTTP ingest 写库"。
- **ingest 鉴权**：采集函数与 API 函数共享 `INGEST_TOKEN` 环境变量，POST 写入需携带令牌。
- **LLM 可选**：配置 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` 环境变量后启用大模型抽取，未配置时自动降级为规则抽取（流水线原有的降级设计）。

## 目录结构

```
ai-daily/
├── cloudbaserc.json              # CloudBase 项目配置
├── web/                          # 前端（无构建依赖的静态站）
│   ├── index.html
│   ├── config.js                 # API 网关地址
│   └── assets/{style.css,app.js}
└── functions/
    ├── aiDailyCollect/           # 每日采集（Python3.10，定时触发）
    │   ├── index.py              # 云函数入口 main(event, context)
    │   ├── requirements.txt      # feedparser + pydantic
    │   ├── brief/                # AI_brief 流水线模块
    │   └── data/trusted_sources.json
    └── aiDailyApi/               # 查询/写入接口（Nodejs18.15，网关 HTTP 触发）
```

## 数据模型

集合 `ai_daily_news`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| title / summary / url | string | 标题 / 摘要 / 原文链接 |
| urlHash | string | URL 的 SHA1 前 16 位，幂等去重 |
| source / sourceId | string | 来源名 / 来源 ID |
| lang / kind | string | `zh`/`en`；`news`/`paper` |
| category | string | 融资 / 产品 / 政策 / 技术 / 其他 |
| entities | string[] | 公司 / 产品 / 人物实体 |
| credibility | number | 可信度 0–100（信源权威性 + 可验证性 + 具体性） |
| score | number | 综合分（可信度 0.7 + 时效 0.3） |
| publishedAt / collectedAt | number | 发布时间 / 采集时间（ms） |
| day | string | 采集日（Asia/Shanghai，`YYYY-MM-DD`） |

集合 `ai_daily_briefs`：`{ day, markdown, report, createdAt }`，按 day upsert。

## API

`GET https://<env>-<appid>.ap-shanghai.app.tcloudbase.com/aiDailyApi`

| 参数 | 说明 |
| --- | --- |
| `day` | 日期，默认当天（上海时区） |
| `lang` / `kind` / `source` / `category` | 过滤条件 |
| `page` / `pageSize` | 分页（pageSize ≤ 100） |
| `mode=days` | 有数据的日期列表 |
| `mode=top&day=...` | 当日综合分最高的条目 |
| `mode=brief&day=...` | 每日简报（markdown + 运行报表） |

写入：`POST /aiDailyApi`，body `{ token, day, items, brief }`。

## 部署

前置：CloudBase 已登录并绑定环境（MCP `auth` 或 `tcb login`）。

```bash
# 1. 创建数据库集合
#    ai_daily_news（索引：day+publishedAt、urlHash）
#    ai_daily_briefs

# 2. 部署 API 函数（Nodejs18.15，Event，环境变量 INGEST_TOKEN）
#    并通过网关创建路由 /aiDailyApi → SCF（auth=false）

# 3. 采集函数 Python 依赖需内置打包（云端不自动装 requirements.txt）：
pip download pydantic==2.9.2 --platform manylinux2014_x86_64 \
  --python-version 3.10 --implementation cp --abi cp310 --only-binary=:all: -d wheels
pip download feedparser==6.0.11 --no-deps -d wheels
# 解包 wheels 到 functions/aiDailyCollect/ 根目录后部署

# 4. 部署采集函数（Python3.10，Event，handler=index.main，timeout=300）
#    环境变量 INGEST_URL / INGEST_TOKEN，触发器 cron 0 30 7 * * * *（7 段）

# 5. 手动触发一次采集灌入首批数据，再部署 web/ 到静态托管
```

## 本地开发

前端是纯静态文件，任意静态服务器即可预览：

```bash
cd web && npx serve .
```

流水线本地调试：

```bash
cd functions/aiDailyCollect && pip install -r requirements.txt
python -c "import asyncio, index; print(asyncio.run(index.run()))"  # 需配置 INGEST_URL/TOKEN
```
