// RAG 门禁（Access Gate）—— 三层防护：
//
// 1) 认证门禁：问答请求必须携带有效令牌。令牌注册表来自 RAG_ACCESS 环境变量：
//      {"tokens": {"<token>": {"user": "alice", "categories": ["融资", "技术"]}}}
//    未配置 RAG_ACCESS 时拒绝一切问答请求（默认关闭，防止裸奔）。
// 2) 范围门禁：检索打分之前先按用户可见分类过滤文档，无权分类的内容
//    连相似度分数都不会产生，杜绝越权内容经分数/引用泄漏。
// 3) 回答门禁：对检索结果做可回答性判定 —— 最高分低于阈值（low_score）、
//    或仅有孤证（weak_singleton：勉强过线且第二名远低于阈值）时拒答，
//    由调用方返回"知识库中没有足够相关的历史简报"，而不是硬编答案。

const DEFAULT_CATEGORIES = ['融资', '产品', '政策', '技术', '其他'];

class AccessGate {
  // accessJson：RAG_ACCESS 环境变量的原文；传 null/非法 JSON 时令牌表为空（全部拒绝）
  constructor(accessJson) {
    this._tokens = {};
    if (accessJson) {
      try {
        const cfg = JSON.parse(accessJson);
        const table = cfg && typeof cfg === 'object' ? (cfg.tokens || cfg) : {};
        for (const [token, info] of Object.entries(table)) {
          if (token && info && typeof info === 'object') this._tokens[token] = info;
        }
      } catch (e) { /* 配置损坏时保持全拒 */ }
    }
  }

  get configured() { return Object.keys(this._tokens).length > 0; }

  // 返回 { user, categories }；令牌无效返回 null
  authenticate(token) {
    const info = token ? this._tokens[token] : null;
    if (!info) return null;
    let cats = Array.isArray(info.categories) && info.categories.length
      ? info.categories.filter(c => DEFAULT_CATEGORIES.includes(c))
      : DEFAULT_CATEGORIES.slice();
    if (!cats.length) cats = DEFAULT_CATEGORIES.slice();
    return { user: String(info.user || 'anonymous'), categories: cats };
  }
}

// 范围门禁：打分前过滤。docs 元素需含 category 字段。
function filterByScope(docs, categories) {
  const allowed = new Set(categories);
  return docs.filter(d => allowed.has((d.category || d.metadata && d.metadata.category) || '其他'));
}

// 回答门禁：scored 为 [{ doc, score }]（按 score 降序）。返回 { ok, reason }
function checkAnswerable(scored, { minScore = 0.15, weakMargin = 1.6 } = {}) {
  if (!scored || !scored.length) return { ok: false, reason: 'no_docs' };
  const best = scored[0].score;
  if (best < minScore) return { ok: false, reason: 'low_score', best };
  if (scored.length > 1) {
    const second = scored[1].score;
    // 孤证：最好的一条只是刚过线，且与第二名没有拉开差距 → 主题不明确，拒答
    if (best < minScore * weakMargin && second < minScore) {
      return { ok: false, reason: 'weak_singleton', best, second };
    }
  }
  return { ok: true, best };
}

const REFUSE_MESSAGES = {
  no_docs: '知识库为空或没有任何可见范围内的历史简报，无法回答。',
  low_score: '检索到的历史简报与问题相关性不足，按门禁策略拒答。',
  weak_singleton: '仅有一条勉强相关的历史简报（孤证），按门禁策略拒答，避免误答。',
};

module.exports = { AccessGate, filterByScope, checkAnswerable, REFUSE_MESSAGES, DEFAULT_CATEGORIES };
