// 简报 → RAG 文档切块
//
// 粒度：每日简报中的每一条精选资讯一个文档。docId 由 url（缺省 day+序号）
// 哈希生成，天然稳定 —— 增量同步时按 docId 判重，已嵌入的条目直接跳过。
const crypto = require('crypto');

function docIdFor(item, day, index) {
  const key = (item.url || `${day}#${index}`).trim();
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

// briefDoc：ai_daily_briefs 集合中的一条记录（含 items 数组）
// 返回 [{ docId, day, title, text, category, url, source, stars, lang }]
function briefToDocs(briefDoc) {
  const day = briefDoc.day;
  const items = Array.isArray(briefDoc.items) ? briefDoc.items : [];
  const docs = [];
  items.forEach((item, i) => {
    if (!item || !item.title) return;
    const parts = [];
    parts.push(`标题：${item.title}`);
    if (item.summary) parts.push(`摘要：${item.summary}`);
    if (item.analysis) parts.push(`编辑点评：${item.analysis}`);
    if (Array.isArray(item.entities) && item.entities.length) {
      parts.push(`相关实体：${item.entities.join('、')}`);
    }
    const header = `【${item.category || '其他'}】${item.source || ''} ${day}` +
      (item.stars != null ? ` ★${item.stars}/5` : '');
    docs.push({
      docId: docIdFor(item, day, i),
      day,
      title: String(item.title),
      text: `${header}\n${parts.join('\n')}`,
      category: item.category || '其他',
      url: item.url || '',
      source: item.source || '',
      stars: item.stars != null ? Number(item.stars) : null,
      lang: item.lang || 'zh',
    });
  });
  return docs;
}

module.exports = { briefToDocs, docIdFor };
