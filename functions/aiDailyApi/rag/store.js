// 向量库访问层：CloudBase 集合 ai_daily_rag_vectors ↔ LangChain MemoryVectorStore
//
// 集合文档结构：
//   { docId, day, title, text, category, url, source, stars, lang,
//     model, dim, embedding: number[], updatedAt }
// 语料规模小（每日 10 条 × 365 天 ≈ 3650 条），全量载入内存做 cosine 检索足够；
// 模块级缓存 10 分钟，同步写库后主动失效。
const { Document } = require('@langchain/core/documents');
const { MemoryVectorStore } = require('langchain/vectorstores/memory');

const VECTORS = 'ai_daily_rag_vectors';
const PAGE = 500;
const CACHE_TTL = 10 * 60 * 1000;

let cache = { ts: 0, docs: [] };

function invalidateCache() { cache = { ts: 0, docs: [] }; }

async function loadVectorDocs(db) {
  const now = Date.now();
  if (now - cache.ts < CACHE_TTL && cache.docs.length) return cache.docs;
  const all = [];
  let offset = 0;
  for (;;) {
    const res = await db.collection(VECTORS).limit(PAGE).skip(offset).get();
    const batch = (res.data) || [];
    all.push(...batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  cache = { ts: now, docs: all };
  return all;
}

// 按当前嵌入模型过滤（不同嵌入空间不可比），再装入向量库
async function buildVectorStore(db, embeddings, modelName) {
  const rows = (await loadVectorDocs(db)).filter(
    r => r.model === modelName && Array.isArray(r.embedding) && r.embedding.length
  );
  const store = new MemoryVectorStore(embeddings);
  store.memoryVectors = rows.map(r => ({
    content: r.text,
    embedding: r.embedding,
    metadata: {
      docId: r.docId, day: r.day, title: r.title, source: r.source,
      category: r.category, url: r.url, stars: r.stars, score: null,
    },
  }));
  return { store, total: rows.length };
}

// 增量 upsert：已存在的 docId 跳过；返回 { added, skipped }
async function upsertVectors(db, docs) {
  const existing = new Set((await loadVectorDocs(db)).map(r => r.docId));
  const fresh = docs.filter(d => !existing.has(d.docId));
  for (let i = 0; i < fresh.length; i += 20) {
    try {
      await db.collection(VECTORS).add(fresh.slice(i, i + 20));
    } catch (e) {
      for (const d of fresh.slice(i, i + 20)) {
        try { await db.collection(VECTORS).add(d); } catch (e2) { /* 单条冲突跳过 */ }
      }
    }
  }
  invalidateCache();
  return { added: fresh.length, skipped: docs.length - fresh.length };
}

// 嵌入模型切换时清空重建（不同向量空间不能混用）
async function clearVectors(db) {
  const res = await db.collection(VECTORS).limit(1000).field({ _id: true }).get();
  for (const d of res.data || []) {
    try { await db.collection(VECTORS).doc(d._id).remove(); } catch (e) { /* 忽略 */ }
  }
  invalidateCache();
  return (res.data || []).length;
}

module.exports = {
  VECTORS, loadVectorDocs, buildVectorStore, upsertVectors, clearVectors, invalidateCache,
};
