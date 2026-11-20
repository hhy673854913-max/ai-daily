// aiDailyApi — 资讯查询 / 写入 HTTP 云函数
//
// 查询（GET，匿名可读）：
//   ?day=2026-11-20&lang=zh&source=xxx&category=技术&page=1&pageSize=30
//   ?mode=days                有数据的日期列表（归档导航）
//   ?mode=top&day=...         当日综合分最高的条目
//   ?mode=brief&day=...       每日简报（markdown + 运行报表）
//
// 写入（POST，需 X-Ingest-Token）：
//   { token, day, items: [...], brief: {...} }   由 aiDailyCollect 采集函数调用
const cloud = require('@cloudbase/node-sdk');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const _ = db.command;
const NEWS = 'ai_daily_news';
const BRIEFS = 'ai_daily_briefs';
const SOURCES = 'ai_daily_sources';
const MAX_PAGE_SIZE = 100;
// 信源注册表参数
const CATEGORIES = ['融资', '产品', '政策', '技术', '其他'];
const ACTIVE_PER_CATEGORY = 3;   // 每类正选上限（合计最多 15 个）
const BAD_STRIKE_LIMIT = 3;      // 连续质量不佳次数上限，超过剔除
const TIER_BASELINE = { 官方公告: 75, 权威媒体: 65, 垂直媒体: 55, 自媒体: 35 };

function shanghaiDay(ts) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(payload),
  };
}

function parseQuery(event) {
  const q = event.queryStringParameters || event.queryString || {};
  if (typeof q === 'string') {
    const params = {};
    for (const kv of q.split('&')) {
      const idx = kv.indexOf('=');
      if (idx > 0) params[decodeURIComponent(kv.slice(0, idx))] = decodeURIComponent(kv.slice(idx + 1));
    }
    return params;
  }
  return q;
}

function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded && raw) raw = Buffer.from(raw, 'base64').toString('utf-8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ---------------- ingest（采集函数写入） ----------------
async function handleIngest(body) {
  const token = process.env.INGEST_TOKEN || '';
  if (!token || body.token !== token) {
    return json(401, { ok: false, error: 'invalid ingest token' });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day || '') ? body.day : shanghaiDay(Date.now());

  // 与库内已有数据按 urlHash 去重
  const hashes = items.map(i => i.urlHash || i.id).filter(Boolean);
  const existing = new Set();
  for (let i = 0; i < hashes.length; i += 50) {
    const res = await db.collection(NEWS)
      .where({ urlHash: _.in(hashes.slice(i, i + 50)) })
      .field({ urlHash: true })
      .limit(100)
      .get();
    (res.data || []).forEach(d => existing.add(d.urlHash));
  }

  let inserted = 0;
  const fresh = items.filter(i => i.url && (i.urlHash || i.id) && !existing.has(i.urlHash || i.id));
  for (let i = 0; i < fresh.length; i += 20) {
    const chunk = fresh.slice(i, i + 20).map(it => ({ ...it, day: it.day || day }));
    try {
      await db.collection(NEWS).add(chunk);
      inserted += chunk.length;
    } catch (e) {
      for (const it of chunk) {
        try { await db.collection(NEWS).add(it); inserted++; } catch (e2) { /* 跳过冲突 */ }
      }
    }
  }

  // 每日简报按 day upsert
  let briefSaved = false;
  if (body.brief && body.brief.markdown) {
    const briefCol = db.collection(BRIEFS);
    const old = await briefCol.where({ day }).limit(1).get();
    const doc = { ...body.brief, day };
    if (old.data && old.data.length) {
      await briefCol.doc(old.data[0]._id).update(doc);
    } else {
      await briefCol.add(doc);
    }
    briefSaved = true;
  }

  return json(200, { ok: true, data: { received: items.length, inserted, briefSaved } });
}

// ---------------- 信源注册表 ----------------
// 质量评估 → EMA 更新 → 类别内排序 → 正选/候选轮换 → 多次不佳剔除
async function handleSourceReport(body) {
  const token = process.env.INGEST_TOKEN || '';
  if (!token || body.token !== token) {
    return json(401, { ok: false, error: 'invalid ingest token' });
  }
  const col = db.collection(SOURCES);

  // 1) 补充候选池里的新源（尚未入库的按 tier 基线入库为 candidate）
  const pool = Array.isArray(body.pool) ? body.pool : [];
  if (pool.length) {
    const existing = await col.limit(1000).field({ name: true }).get();
    const known = new Set((existing.data || []).map(d => d.name));
    const fresh = pool
      .filter(p => p && p.name && p.rss && !known.has(p.name))
      .map(p => ({
        name: p.name,
        rss: p.rss,
        category: CATEGORIES.includes(p.category) ? p.category : '其他',
        tier: p.tier || '垂直媒体',
        status: 'candidate',
        quality: TIER_BASELINE[p.tier] != null ? TIER_BASELINE[p.tier] : 50,
        runs: 0,
        consecutiveBad: 0,
        updatedAt: Date.now(),
      }));
    for (let i = 0; i < fresh.length; i += 20) {
      try { await col.add(fresh.slice(i, i + 20)); } catch (e) { /* 并发兜底 */ }
    }

    // 1b) 采集池里已不存在的源 = 编辑决策移除，直接标记 removed（不再参与排序与抓取）
    const poolNames = new Set(pool.map(p => p && p.name).filter(Boolean));
    const stale = await col.where({ status: _.neq('removed') }).limit(1000).get();
    let retired = 0;
    for (const d of stale.data || []) {
      if (d.name && !poolNames.has(d.name)) {
        await col.doc(d._id).update({ status: 'removed', updatedAt: Date.now() });
        retired++;
      }
    }
  }

  // 2) 应用本轮质量报告：EMA 质量分 + 连续不佳计数
  const reports = Array.isArray(body.reports) ? body.reports : [];
  for (const r of reports) {
    if (!r || !r.name) continue;
    const res = await col.where({ name: r.name }).limit(1).get();
    const doc = res.data && res.data[0];
    if (!doc) continue;
    const runScore = Number(r.runScore) || 0;
    const quality = doc.runs > 0
      ? Math.round((0.5 * runScore + 0.5 * doc.quality) * 10) / 10
      : Math.round(runScore * 10) / 10;
    const consecutiveBad = r.bad ? (doc.consecutiveBad || 0) + 1 : 0;
    const removed = consecutiveBad >= BAD_STRIKE_LIMIT;
    await col.doc(doc._id).update({
      quality,
      runs: (doc.runs || 0) + 1,
      lastRunScore: runScore,
      consecutiveBad,
      status: removed ? 'removed' : doc.status,
      lastRunAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  // 3) 类别内重排：非 removed 按质量分排序，每类前 ACTIVE_PER_CATEGORY 名为正选
  const all = await col.where({ status: _.neq('removed') }).limit(1000).get();
  const byCat = {};
  for (const d of all.data || []) {
    const cat = CATEGORIES.includes(d.category) ? d.category : '其他';
    (byCat[cat] = byCat[cat] || []).push(d);
  }
  let promoted = 0;
  for (const cat of CATEGORIES) {
    const group = (byCat[cat] || []).sort((a, b) =>
      (b.quality - a.quality) || ((b.runs || 0) - (a.runs || 0)));
    for (let i = 0; i < group.length; i++) {
      const next = i < ACTIVE_PER_CATEGORY ? 'active' : 'candidate';
      if (group[i].status !== next) {
        await col.doc(group[i]._id).update({ status: next, updatedAt: Date.now() });
        if (next === 'active') promoted++;
      }
    }
  }
  return json(200, { ok: true, data: { applied: reports.length, promoted, retired: typeof retired === 'number' ? retired : 0 } });
}

async function handleGetSources() {
  const col = db.collection(SOURCES);
  const res = await col.where({ status: _.neq('removed') }).limit(1000).get();
  const sources = (res.data || []).map(d => ({
    name: d.name,
    rss: d.rss,
    category: d.category,
    tier: d.tier,
    status: d.status,
    quality: d.quality,
    runs: d.runs || 0,
  }));
  // 正选在前、候选在后，各自按质量降序
  const rank = s => (s.status === 'active' ? 0 : 1);
  sources.sort((a, b) => (rank(a) - rank(b)) || (b.quality - a.quality));
  return json(200, { ok: true, data: { sources } });
}

// ---------------- 入口 ----------------
exports.main = async (event) => {
  const method = (event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET').toUpperCase();
  if (method === 'OPTIONS') return json(204, {});

  try {
    if (method === 'POST') {
      const body = parseBody(event);
      if (body.mode === 'sourceReport') return await handleSourceReport(body);
      if (body.mode === 'ingest' || body.token) return await handleIngest(body);
      return json(400, { ok: false, error: 'unknown POST mode' });
    }

    const q = parseQuery(event);
    const col = db.collection(NEWS);

    if (q.mode === 'sources') {
      return await handleGetSources();
    }

    if (q.mode === 'days') {
      // 归档：有简报的日期（来自 ai_daily_briefs）
      const res = await db.collection(BRIEFS)
        .orderBy('day', 'desc')
        .limit(365)
        .field({ day: true })
        .get();
      const days = [...new Set((res.data || []).map(d => d.day))];
      return json(200, { ok: true, data: { days } });
    }

    if (q.mode === 'brief') {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') ? q.day : shanghaiDay(Date.now());
      const res = await db.collection(BRIEFS).where({ day }).limit(1).get();
      const brief = res.data && res.data[0];
      if (!brief) return json(200, { ok: true, data: { day, brief: null } });
      return json(200, { ok: true, data: { day, brief } });
    }

    const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') ? q.day : shanghaiDay(Date.now());
    const where = { day };
    if (q.lang && ['zh', 'en'].includes(q.lang)) where.lang = q.lang;
    if (q.kind && ['news', 'paper'].includes(q.kind)) where.kind = q.kind;
    if (q.source) where.sourceId = String(q.source);
    if (q.category && ['融资', '产品', '政策', '技术', '其他'].includes(q.category)) where.category = q.category;

    if (q.mode === 'top') {
      const res = await col.where(where).orderBy('score', 'desc').limit(5).get();
      return json(200, { ok: true, data: { day, items: res.data || [] } });
    }

    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(q.pageSize, 10) || 30));

    const [countRes, listRes] = await Promise.all([
      col.where(where).count(),
      col.where(where).orderBy('score', 'desc').skip((page - 1) * pageSize).limit(pageSize).get(),
    ]);

    return json(200, {
      ok: true,
      data: { day, page, pageSize, total: countRes.total || 0, items: listRes.data || [] },
    });
  } catch (e) {
    console.error('api error:', e);
    return json(500, { ok: false, error: e.message });
  }
};
