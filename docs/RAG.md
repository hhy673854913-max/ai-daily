# RAG 简报问答

> 「简报问答」功能的完整设计文档：数据流、模块实现、三重门禁、嵌入策略、运维操作。
> 代码全部位于 [functions/aiDailyApi/rag/](file:///c:/space/ai-daily/functions/aiDailyApi/rag)，入口分发在 [index.js](file:///c:/space/ai-daily/functions/aiDailyApi/index.js)。

## 1. 设计目标与总体思路

基于**历史每日简报**的检索问答（不是全网新闻，语料就是 `ai_daily_briefs` 里每天精选的 10 条）。核心取舍：

- **语料小**（10 条/天 × 365 天 ≈ 3650 条）→ 向量全量载入内存做 cosine 检索，不引入专用向量数据库，CloudBase 集合即存储。
- **零配置可用** → 未配置任何密钥时，嵌入降级为内置 hashing-v2，问答降级为摘录式回答，整条链路仍可运行。
- **默认关闭、最小授权** → 未配置 `RAG_ACCESS` 时拒绝一切问答；每个令牌可按分类授权，无权内容连相似度分数都不产生。

## 2. 数据流

### 写入链路（ragSync）

```
ai_daily_briefs (每日简报)
   │  briefToDocs：每条精选资讯 → 一个 RAG 文档
   │  docId = sha1(url) 前 16 位（缺 url 用 day#序号），天然稳定 → 增量判重键
   ▼
嵌入（OpenAI 兼容接口 或 内置 hashing-v2，批大小 10）
   ▼
ai_daily_rag_vectors (upsert，已存在的 docId 跳过)
```

触发方式（三选一，效果相同）：

1. 定时触发器 `rag-sync-0750`（每天 07:50，采集完成后自动增量同步）；
2. `POST { mode:'ragSync', token:<INGEST_TOKEN> }`；
3. 定时器事件进入 `exports.main` 时 `event.Type === 'timer'` 自动执行。

**模型切换保护**：ragSync 先比对库内向量的 `model` 与当前嵌入模型名，不一致则 `clearVectors` 全量清空后重建——不同嵌入空间的向量不可混用。

### 查询链路（ask）

```
用户问题 (GET ?mode=ask&q=... 或 POST {mode:'ask', question})
   │
   ├─ ① 认证门禁：AccessGate.authenticate(token)  → 无效 401；未配置 RAG_ACCESS 403
   │
   ├─ buildVectorStore：载入 ai_daily_rag_vectors（10 分钟模块级缓存）
   │                    按当前嵌入模型过滤 → 装入 MemoryVectorStore
   │
   ├─ ② 范围门禁：similaritySearchWithScore(question, TOP_K=6, filter)
   │              filter 按令牌可见 categories 过滤 metadata.category，
   │              无权分类的文档不产生相似度分数
   │
   ├─ ③ 回答门禁：checkAnswerable(scored, minScore)
   │        no_docs / low_score / weak_singleton → 返回 refused 载荷（HTTP 200）
   │
   ├─ 生成：createChain() 有 LLM_API_KEY → LCEL 链（Prompt→ChatOpenAI→Parser）
   │         否则 → extractiveAnswer 摘录式降级回答
   ▼
{ refused:false, answer, user, model, citations:[{day,title,url,source,category,stars,score}] }
```

## 3. 模块详解

### 3.1 门禁 [gate.js](file:///c:/space/ai-daily/functions/aiDailyApi/rag/gate.js)

三层防护，层层独立：

| 层 | 实现 | 失败表现 |
| --- | --- | --- |
| 认证 | `AccessGate` 解析 `RAG_ACCESS` JSON 为令牌表；配置损坏/未配置 = 空表全拒 | 401 / 403 |
| 范围 | `filterByScope` / ask 内的 `scopedFilter`，打分**之前**过滤分类 | 无权内容不出现在检索结果 |
| 回答 | `checkAnswerable`：最高分 < `minScore` 拒答（`low_score`）；最高分勉强过线（< `minScore*1.6`）且第二名低于线，判定孤证拒答（`weak_singleton`） | HTTP 200 + `refused:true` + 原因文案 |

`RAG_ACCESS` 格式（环境变量，JSON 字符串）：

```json
{
  "tokens": {
    "<token-a>": { "user": "alice", "categories": ["融资", "技术"] },
    "<token-b>": { "user": "bob" }
  }
}
```

- `categories` 缺省或为空数组 = 全部分类（`融资/产品/政策/技术/其他`）；非法分类名会被过滤。
- 拒答文案集中在 `REFUSE_MESSAGES`，拒答也是 200（业务态而非传输态错误），前端按 `data.refused` 区分。

### 3.2 嵌入 [embeddings.js](file:///c:/space/ai-daily/functions/aiDailyApi/rag/embeddings.js)

`createEmbeddings()` 按环境变量二选一：

- **OpenAI 兼容嵌入**：存在 `EMBEDDING_API_KEY`（缺省回退 `LLM_API_KEY`）时启用；`EMBEDDING_MODEL` 缺省 `text-embedding-3-small`；`EMBEDDING_DIMENSIONS` 用于 DashScope 等要求显式维度的服务。
- **HashingEmbeddings（hashing-v2，1024 维）**：零依赖兜底。分词策略——西文按词（长词截前 5 字符缓解词形变化）+ CJK uni-gram/bigram；FNV-1a 哈希定位 + 哈希位决定 ± 符号，L2 归一。确定性、可离线、跨机器一致，语义能力弱于真嵌入但足以支撑关键词型检索。

`embeddingModelName()` 返回模型名，是向量库 `model` 字段与模型切换检测的依据（hashing 恒为 `hashing-v2`）。

### 3.3 切块 [chunk.js](file:///c:/space/ai-daily/functions/aiDailyApi/rag/chunk.js)

粒度 = 简报中的一条资讯一个文档。`text` 拼装：

```
【分类】来源 日期 ★星级/5
标题：...
摘要：...
编辑点评：...        （有 analysis 时）
相关实体：A、B、C     （有 entities 时）
```

`docId` 用 url 的 SHA-1 前 16 位，同一 URL 永远同 ID → 增量同步天然幂等；条目内容变更不会触发更新（只判存在性），这是当前实现的已知取舍。

### 3.4 向量存储 [store.js](file:///c:/space/ai-daily/functions/aiDailyApi/rag/store.js)

- 集合 `ai_daily_rag_vectors` 文档：`{docId, day, title, text, category, url, source, stars, lang, model, dim, embedding:number[], updatedAt}`；embedding 写入前四舍五入到 1e-6 控制文档体积。
- `loadVectorDocs`：分页 500 全量拉取，模块级缓存 10 分钟；写库后 `invalidateCache`。
- `buildVectorStore`：按当前模型过滤后塞进 LangChain `MemoryVectorStore`（预置 `memoryVectors`，检索时 cosine 相似度）。
- `upsertVectors`：按 docId 判重跳过，批量 20 写入，单条冲突跳过。
- `clearVectors`：模型切换时全量删除（单次上限 1000 条，语料规模内足够）。

### 3.5 问答链 [chain.js](file:///c:/space/ai-daily/functions/aiDailyApi/rag/chain.js)

- LCEL：`ChatPromptTemplate(system + human) → ChatOpenAI(temperature=0.2) → StringOutputParser`。
- 系统提示词本身是回答门禁的一部分：仅依据资料作答、不足要明说、引用标注 `[n]` 编号、300 字内、矛盾指出而非取舍。
- `formatDocs` 给每个片段编号 `[i]`，与返回的 `citations` 数组一一对应。
- `extractiveAnswer`：无 LLM 时的降级——直接罗列检索到的原始摘录（带相关度分值），不生成新文本。

### 3.6 入口分发 [index.js](file:///c:/space/ai-daily/functions/aiDailyApi/index.js)

| Handler | 说明 |
| --- | --- |
| `handleAsk` | 认证 → 建库 → 范围过滤检索 → 可答性判定 → LLM/摘录生成 → citations |
| `handleRagSync` | 模型切换检测 → 拉全部简报（分页 100）→ 切块 → 判重 → 分批嵌入写入 |
| `handleRagStatus` | 向量总数 / 覆盖日期范围 / 模型列表 / 当前令牌身份 |

常量：`RAG_TOP_K = 6`（检索条数）、`EMBED_BATCH = 10`。

## 4. 环境变量速查

| 变量 | 作用 | 缺省行为 |
| --- | --- | --- |
| `RAG_ACCESS` | 问答令牌注册表（JSON） | 未配置 = 问答/ ragStatus 全部 403 |
| `INGEST_TOKEN` | ragSync 鉴权 | 未配置 = ragSync 全拒 |
| `LLM_API_KEY / LLM_BASE_URL / LLM_MODEL` | 问答生成模型 | 未配置 = 摘录式降级回答 |
| `EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL / EMBEDDING_DIMENSIONS` | 嵌入服务 | 未配置 = 内置 hashing-v2（密钥缺省回退 LLM_*） |
| `RAG_MIN_SCORE` | 拒答相关性阈值 | hashing 0.18 / OpenAI 0.35 |

注意：切换嵌入模型（含 hashing ↔ OpenAI 互切）后，下次 ragSync 会自动清空向量库重建，期间检索结果为空属正常。

## 5. 调用示例

```bash
# 问答（令牌放头里，避免进日志/URL）
curl -X POST 'https://<env>-<appid>.ap-shanghai.app.tcloudbase.com/aiDailyApi' \
  -H 'Content-Type: application/json' \
  -H 'X-Rag-Token: <你的令牌>' \
  -d '{"mode":"ask","question":"最近有哪些大模型融资事件？"}'

# 向量库状态
curl 'https://<env>-<appid>.ap-shanghai.app.tcloudbase.com/aiDailyApi?mode=ragStatus&token=<你的令牌>'

# 手动全量/增量同步（首次启用或排查时用）
curl -X POST 'https://<env>-<appid>.ap-shanghai.app.tcloudbase.com/aiDailyApi' \
  -H 'Content-Type: application/json' \
  -d '{"mode":"ragSync","token":"<INGEST_TOKEN>"}'
```

成功回答响应：

```json
{
  "ok": true,
  "data": {
    "refused": false,
    "answer": "……[1][2]",
    "user": "alice",
    "model": "text-embedding-3-small",
    "citations": [{ "day": "2026-11-20", "title": "…", "url": "…", "source": "36氪", "category": "融资", "stars": 4.5, "score": 0.512 }]
  }
}
```

拒答响应（HTTP 仍为 200）：

```json
{ "ok": true, "data": { "refused": true, "reason": "low_score", "user": "alice", "message": "检索到的历史简报与问题相关性不足，按门禁策略拒答。" } }
```

`reason` 取值：`no_docs`（库空或可见范围无文档）/ `low_score`（相关性不足）/ `weak_singleton`（孤证）。

## 6. 测试与调优

- 单元测试：[tests/rag.test.js](file:///c:/space/ai-daily/functions/aiDailyApi/tests/rag.test.js)，覆盖门禁 / 嵌入 / 切块 / 检索 / 降级回答。运行：`cd functions/aiDailyApi && node --test tests/rag.test.js`。
- 相关性不满意时：先确认嵌入模型（`ragStatus` 看 `models`），hashing-v2 只擅长关键词重合型问题；语义型问题建议配置真嵌入。
- 阈值调优：改 `RAG_MIN_SCORE`；孤证判定系数 `weakMargin=1.6` 在 `gate.checkAnswerable` 中。
- 检索条数：`RAG_TOP_K`（index.js 常量，当前 6）。

## 7. 已知取舍与后续方向

- 向量检索全量载入内存：语料 ≈3650 条时可行；若未来接入全量新闻（`ai_daily_news`）需换真正的向量索引。
- 增量只按 docId 判存在：条目内容更新不会重嵌入；如需支持，可在 upsert 时比对内容哈希。
- `clearVectors` 单次最多清 1000 条：超出需多次触发 ragSync。
- 分类集合硬编码 5 类，门禁、切块、注册表多处引用，新增分类需同步多处（见 ARCHITECTURE.md「常见迭代入口」）。
