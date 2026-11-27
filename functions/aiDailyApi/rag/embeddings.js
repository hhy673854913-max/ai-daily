// RAG 向量嵌入
//
// 优先使用 OpenAI 兼容的 Embedding 接口（EMBEDDING_API_KEY / EMBEDDING_BASE_URL /
// EMBEDDING_MODEL，缺省回退到 LLM_* 环境变量）；未配置任何密钥时降级为内置
// HashingEmbeddings —— 字符 n-gram 哈希 + L2 归一，零依赖、可离线、可复现，
// 保证 RAG 链路开箱可用。
const { OpenAIEmbeddings } = require('@langchain/openai');

const HASH_DIM = 1024;

// FNV-1a 32bit —— 稳定哈希，同一文本任何机器上结果一致
function hashToken(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 分词：西文按词、CJK 按 uni-gram + bi-gram（中文无空格分词，bigram 是
// 性价比最高的近似），覆盖 1-3 字的关键词（如"大模型""RLHF"）
function ngrams(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const words = s.match(/[a-z0-9][a-z0-9._+-]*/g) || [];
  for (const w of words) {
    out.push('w:' + w);
    if (w.length > 5) out.push('wp:' + w.slice(0, 5)); // 长词截断，缓解词形变化
  }
  const cjk = s.match(/[㐀-䶿一-鿿豈-﫿]/g) || [];
  for (let i = 0; i < cjk.length; i++) {
    out.push('c:' + cjk[i]);
    if (i + 1 < cjk.length) out.push('c2:' + cjk[i] + cjk[i + 1]);
  }
  return out;
}

class HashingEmbeddings {
  constructor(dim = HASH_DIM) {
    this.dim = dim;
  }
  get modelName() { return 'hashing-v2'; }
  async embedDocuments(texts) { return texts.map(t => this.embed(t)); }
  async embedQuery(text) { return this.embed(text); }
  embed(text) {
    const vec = new Array(this.dim).fill(0);
    for (const g of ngrams(text)) {
      const h = hashToken(g);
      vec[h % this.dim] += ((h >> 9) & 1) ? 1 : -1; // 哈希位决定符号，正负均衡
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return vec.map(v => v / norm);
  }
}

// 由环境变量决定嵌入实现；返回对象带 modelName 便于向量库存储与模型切换检测
function createEmbeddings(env = process.env) {
  const key = env.EMBEDDING_API_KEY || env.LLM_API_KEY || '';
  if (key) {
    const model = env.EMBEDDING_MODEL || 'text-embedding-3-small';
    const options = {
      apiKey: key,
      model,
      configuration: { baseURL: env.EMBEDDING_BASE_URL || env.LLM_BASE_URL },
      maxRetries: 2,
    };
    // 部分服务（如 DashScope 兼容模式）需要显式指定维度
    const dims = parseInt(env.EMBEDDING_DIMENSIONS, 10);
    if (dims > 0) options.dimensions = dims;
    return new OpenAIEmbeddings(options);
  }
  return new HashingEmbeddings();
}

function embeddingModelName(embeddings) {
  return embeddings.modelName || (embeddings.model && (embeddings.model.modelName || embeddings.model)) || 'unknown';
}

module.exports = { HashingEmbeddings, createEmbeddings, embeddingModelName, HASH_DIM, hashToken, ngrams };
