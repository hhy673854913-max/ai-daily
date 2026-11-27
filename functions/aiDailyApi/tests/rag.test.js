// RAG 模块单元测试：node --test tests/（在 functions/aiDailyApi 目录下运行）
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { AccessGate, filterByScope, checkAnswerable, DEFAULT_CATEGORIES } = require('../rag/gate');
const { HashingEmbeddings, createEmbeddings, embeddingModelName } = require('../rag/embeddings');
const { briefToDocs } = require('../rag/chunk');
const { formatDocs, extractiveAnswer, createChain } = require('../rag/chain');
const vectorStore = require('../rag/store');

// ---------- 门禁 ----------

test('认证门禁：有效令牌返回身份，无效/缺失返回 null', () => {
  const gate = new AccessGate(JSON.stringify({
    tokens: {
      'key-alice': { user: 'alice', categories: ['融资', '技术'] },
      'key-bob': { user: 'bob' },
    },
  }));
  assert.strictEqual(gate.configured, true);
  const alice = gate.authenticate('key-alice');
  assert.deepStrictEqual(alice, { user: 'alice', categories: ['融资', '技术'] });
  // 未声明 categories → 默认全部分类
  assert.deepStrictEqual(gate.authenticate('key-bob').categories, DEFAULT_CATEGORIES);
  assert.strictEqual(gate.authenticate('wrong'), null);
  assert.strictEqual(gate.authenticate(''), null);
});

test('认证门禁：未配置 RAG_ACCESS 时全部拒绝', () => {
  const gate = new AccessGate('');
  assert.strictEqual(gate.configured, false);
  assert.strictEqual(gate.authenticate('anything'), null);
  const broken = new AccessGate('{not-json');
  assert.strictEqual(broken.configured, false);
});

test('认证门禁：非法分类名被丢弃', () => {
  const gate = new AccessGate(JSON.stringify({ tokens: { k: { user: 'u', categories: ['融资', '机密'] } } }));
  assert.deepStrictEqual(gate.authenticate('k').categories, ['融资']);
});

test('范围门禁：无权分类的文档在打分前被剔除', () => {
  const docs = [
    { docId: '1', category: '融资' },
    { docId: '2', category: '技术' },
    { docId: '3', category: '政策' },
  ];
  const scoped = filterByScope(docs, ['融资']);
  assert.deepStrictEqual(scoped.map(d => d.docId), ['1']);
});

test('回答门禁：空结果 / 低分 / 孤证 / 正常通过', () => {
  assert.deepStrictEqual(checkAnswerable([], { minScore: 0.1 }).reason, 'no_docs');
  assert.deepStrictEqual(checkAnswerable([{ score: 0.05 }], { minScore: 0.1 }).reason, 'low_score');
  // 孤证：best=0.13 刚过 minScore=0.1 的 1.6 倍线以下，second=0.02 远低于阈值
  const weak = checkAnswerable([{ score: 0.13 }, { score: 0.02 }], { minScore: 0.1, weakMargin: 1.6 });
  assert.deepStrictEqual(weak, { ok: false, reason: 'weak_singleton', best: 0.13, second: 0.02 });
  // 强信号通过
  assert.strictEqual(checkAnswerable([{ score: 0.5 }, { score: 0.4 }], { minScore: 0.1 }).ok, true);
  // 孤证但置信高（best ≥ minScore*margin）→ 放行
  assert.strictEqual(checkAnswerable([{ score: 0.3 }, { score: 0.02 }], { minScore: 0.1, weakMargin: 1.6 }).ok, true);
});

// ---------- 嵌入 ----------

test('HashingEmbeddings：确定性 + 单位向量', async () => {
  const emb = new HashingEmbeddings();
  const a = await emb.embedQuery('大模型 融资 亿元');
  const b = await emb.embedQuery('大模型 融资 亿元');
  assert.deepStrictEqual(a, b);
  const norm = Math.hypot(...a);
  assert.ok(Math.abs(norm - 1) < 1e-9, 'norm should be 1, got ' + norm);
  assert.strictEqual(emb.modelName, 'hashing-v2');
});

test('HashingEmbeddings：语义近邻排在无关文档之前', async () => {
  const emb = new HashingEmbeddings();
  const store = await vectorStore.buildVectorStore(mockDb([
    row('d1', '某AI公司完成10亿元B轮融资，用于大模型训练集群扩容', '融资', 'hashing-v2'),
    row('d2', '量子计算原型机实现新的纠错里程碑', '技术', 'hashing-v2'),
    row('d3', '开源社区发布新一代推理框架，显存占用下降40%', '技术', 'hashing-v2'),
  ]), emb, 'hashing-v2');
  const scored = await store.store.similaritySearchWithScore('哪家公司融资了多少钱', 3);
  assert.strictEqual(scored[0][0].metadata.docId, 'd1');
  assert.ok(scored[0][1] > scored[scored.length - 1][1]);
});

test('嵌入工厂：无密钥降级 HashingEmbeddings，有密钥走 OpenAI', () => {
  const hashEmb = createEmbeddings({});
  assert.ok(hashEmb instanceof HashingEmbeddings);
  const openaiEmb = createEmbeddings({ LLM_API_KEY: 'sk-test', LLM_BASE_URL: 'https://x/v1' });
  assert.strictEqual(embeddingModelName(openaiEmb), 'text-embedding-3-small');
  assert.strictEqual(embeddingModelName(hashEmb), 'hashing-v2');
});

// ---------- 切块 ----------

test('切块：文档字段完整、docId 稳定', () => {
  const brief = {
    day: '2026-11-20',
    items: [
      { title: '甲公司融资10亿', url: 'https://a.com/1', summary: '摘要A', analysis: '点评A', category: '融资', source: '36氪', stars: 4, entities: ['甲公司'], lang: 'zh' },
      { title: '乙框架发布', url: 'https://b.com/2', category: '技术', source: 'InfoQ' },
      { title: '' }, // 应被跳过
    ],
  };
  const docs = briefToDocs(brief);
  assert.strictEqual(docs.length, 2);
  assert.strictEqual(docs[0].docId, briefToDocs(brief)[0].docId); // 稳定
  assert.ok(docs[0].text.includes('摘要：摘要A'));
  assert.ok(docs[0].text.includes('编辑点评：点评A'));
  assert.ok(docs[0].text.includes('甲公司'));
  assert.ok(docs[0].text.includes('★4/5'));
  assert.strictEqual(docs[1].category, '技术');
  assert.notStrictEqual(docs[0].docId, docs[1].docId);
});

// ---------- 向量库 ----------

test('向量库：按嵌入模型过滤 + 范围过滤检索', async () => {
  const emb = new HashingEmbeddings();
  const db = mockDb([
    row('a1', '甲公司完成巨额融资，投向大模型基础设施', '融资', 'hashing-v2'),
    row('a2', '新模型发布，多模态能力升级', '产品', 'hashing-v2'),
    row('old', '旧模型空间里的文档', '融资', 'openai-legacy'),
  ]);
  const { store, total } = await vectorStore.buildVectorStore(db, emb, 'hashing-v2');
  assert.strictEqual(total, 2); // legacy 模型文档被排除
  const hits = await store.similaritySearchWithScore('融资 大模型', 5, m => m.metadata.category === '融资');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0][0].metadata.docId, 'a1');
});

// ---------- 回答链 ----------

test('formatDocs：编号与引用一一对应', () => {
  const docs = [
    { pageContent: '内容一', metadata: { day: '2026-11-20', title: '标题一', source: '36氪', stars: 4 } },
    { pageContent: '内容二', metadata: { day: '2026-11-19', title: '标题二' } },
  ];
  const out = formatDocs(docs);
  assert.ok(out.startsWith('[1] 2026-11-20《标题一》（36氪） ★4/5\n内容一'));
  assert.ok(out.includes('[2] 2026-11-19《标题二》'));
});

test('摘录式降级回答：无 LLM 时返回原文摘录', () => {
  const docs = [{ pageContent: '头\n正文摘录', metadata: { day: '2026-11-20', title: 'T', score: 0.42 } }];
  const out = extractiveAnswer(docs);
  assert.ok(out.includes('未配置 LLM'));
  assert.ok(out.includes('相关度 0.42'));
  assert.ok(out.includes('正文摘录'));
});

test('createChain：未配置 LLM_API_KEY 时返回 null', () => {
  assert.strictEqual(createChain({}), null);
});

// ---------- 测试辅助 ----------

const _rowEmb = new HashingEmbeddings();

function row(docId, text, category, model) {
  return { docId, day: '2026-11-20', title: text.slice(0, 10), text, category, url: '', source: '', stars: 3, model, embedding: _rowEmb.embed(text) };
}

// 最小 CloudBase db 替身：仅实现本测试用到的 limit/skip/get 链
function mockDb(rows) {
  vectorStore.invalidateCache(); // 避免模块级缓存串数据
  return {
    collection() {
      const chain = {
        async get() { return { data: rows.slice() }; },
      };
      chain.limit = () => chain;
      chain.skip = () => chain;
      chain.field = () => chain;
      return chain;
    },
  };
}
