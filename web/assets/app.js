// AI 日报前端逻辑
(function () {
  'use strict';

  var API_BASE = (window.AI_DAILY_CONFIG && window.AI_DAILY_CONFIG.apiBase) || '';
  var API_URL = API_BASE.replace(/\/$/, '') + '/aiDailyApi';

  var state = {
    view: 'feed', // feed | brief
    day: todayShanghai(),
    lang: '',
    source: '',
    page: 1,
    pageSize: 30,
    total: 0,
    loading: false,
  };

  var SOURCE_NAMES = {
    jiqizhixin: '机器之心',
    qbitai: '量子位',
    '36kr': '36氪',
    infoq: 'InfoQ',
    techcrunch: 'TechCrunch',
    theverge: 'The Verge',
    arxiv: 'arXiv',
  };

  var CATEGORY_COLORS = {
    '融资': '#8c2c1a',
    '产品': '#1a5f7a',
    '政策': '#6b4fa0',
    '技术': '#2e6b34',
    '其他': '#8a8271',
  };

  // ---------- 工具 ----------
  function todayShanghai() {
    return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  }

  function shiftDay(day, delta) {
    var t = Date.parse(day + 'T00:00:00Z') + delta * 86400e3;
    return new Date(t).toISOString().slice(0, 10);
  }

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtTime(ts) {
    var d = new Date(ts + 8 * 3600e3);
    return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
  }

  function fmtDayCn(day) {
    var p = day.split('-');
    return p[0] + ' 年 ' + Number(p[1]) + ' 月 ' + Number(p[2]) + ' 日';
  }

  function weekdayCn(day) {
    var w = new Date(day + 'T00:00:00Z').getUTCDay();
    return ['日', '一', '二', '三', '四', '五', '六'][w];
  }

  function fetchJson(params) {
    var qs = Object.keys(params)
      .filter(function (k) { return params[k] !== '' && params[k] != null; })
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return fetch(API_URL + '?' + qs).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (body) {
      if (!body.ok) throw new Error(body.error || 'API error');
      return body.data;
    });
  }

  // ---------- 资讯流渲染 ----------
  function renderMeta(item) {
    var meta = el('div', 'meta');
    meta.appendChild(el('span', null, item.source || SOURCE_NAMES[item.sourceId] || item.sourceId));
    meta.appendChild(el('span', null, fmtTime(item.publishedAt)));
    if (item.credibility != null) {
      meta.appendChild(el('span', 'cred', '可信度 ' + item.credibility));
    }
    if (item.score > 0) meta.appendChild(el('span', 'score', '综合分 ' + item.score));
    return meta;
  }

  function renderItem(item) {
    var a = el('a', 'item');
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener';

    var head = el('div', 'item-head');
    head.appendChild(el('span', 'item-title', item.title));
    if (item.category) {
      var badge = el('span', 'badge cat-badge', item.category);
      badge.style.borderColor = CATEGORY_COLORS[item.category] || '#8a8271';
      badge.style.color = CATEGORY_COLORS[item.category] || '#8a8271';
      head.appendChild(badge);
    }
    head.appendChild(el('span', 'badge', item.lang === 'zh' ? '中文' : 'EN'));
    a.appendChild(head);

    if (item.summary) a.appendChild(el('p', 'item-summary', item.summary));

    if (item.entities && item.entities.length) {
      var tags = el('div', 'entities');
      item.entities.slice(0, 6).forEach(function (e) {
        tags.appendChild(el('span', 'entity', e));
      });
      a.appendChild(tags);
    }
    a.appendChild(renderMeta(item));
    return a;
  }

  function renderTop(items) {
    var section = $('top-section');
    var grid = $('top-stories');
    grid.innerHTML = '';
    var top = items.slice(0, 3);
    if (top.length === 0) { section.hidden = true; return; }
    section.hidden = false;
    top.forEach(function (item, i) {
      var a = el('a', 'top-card');
      a.href = item.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.appendChild(el('span', 'rank', 'No.' + (i + 1)));
      a.appendChild(el('h3', null, item.title));
      a.appendChild(renderMeta(item));
      grid.appendChild(a);
    });
  }

  function renderSkeleton() {
    var feed = $('feed');
    feed.innerHTML = '';
    for (var i = 0; i < 5; i++) {
      var s = el('div', 'skeleton');
      s.appendChild(el('div', 'line w60'));
      s.appendChild(el('div', 'line w90'));
      s.appendChild(el('div', 'line w40'));
      feed.appendChild(s);
    }
  }

  function setState(html, showRetry) {
    var box = $('feed-state');
    box.innerHTML = html || '';
    if (showRetry) {
      var btn = el('button', 'retry', '重试');
      btn.onclick = function () { loadFeed(true); };
      box.appendChild(btn);
    }
  }

  function renderChips() {
    var wrap = $('source-chips');
    wrap.innerHTML = '';
    var all = el('button', 'chip' + (state.source === '' ? ' active' : ''), '全部来源');
    all.onclick = function () { state.source = ''; loadFeed(true); };
    wrap.appendChild(all);
    Object.keys(SOURCE_NAMES).forEach(function (id) {
      var c = el('button', 'chip' + (state.source === id ? ' active' : ''), SOURCE_NAMES[id]);
      c.onclick = function () {
        state.source = state.source === id ? '' : id;
        loadFeed(true);
      };
      wrap.appendChild(c);
    });
  }

  function renderNav() {
    $('current-day').textContent = state.day + ' 周' + weekdayCn(state.day);
    $('next-day').disabled = state.day >= todayShanghai();
  }

  // ---------- 简报渲染（渲染流水线生成的 markdown 子集） ----------
  function inlineMd(text) {
    var frag = document.createDocumentFragment();
    var re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2] != null) {
        frag.appendChild(el('strong', null, m[2]));
      } else if (m[3] != null) {
        frag.appendChild(el('code', null, m[3]));
      } else {
        var a = el('a', null, m[4]);
        a.href = m[5];
        a.target = '_blank';
        a.rel = 'noopener';
        frag.appendChild(a);
      }
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function renderBrief(markdown) {
    var box = $('brief-content');
    box.innerHTML = '';
    markdown.split('\n').forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      if (t.indexOf('### ') === 0) {
        var h3 = el('h3'); h3.appendChild(inlineMd(t.slice(4))); box.appendChild(h3);
      } else if (t.indexOf('## ') === 0) {
        var h2 = el('h2'); h2.appendChild(inlineMd(t.slice(3))); box.appendChild(h2);
      } else if (t.indexOf('# ') === 0) {
        var h1 = el('h1'); h1.appendChild(inlineMd(t.slice(2))); box.appendChild(h1);
      } else if (t.indexOf('> ') === 0) {
        var bq = el('blockquote'); bq.appendChild(inlineMd(t.slice(2))); box.appendChild(bq);
      } else {
        var p = el('p'); p.appendChild(inlineMd(t)); box.appendChild(p);
      }
    });
  }

  function loadBrief() {
    var st = $('brief-state');
    st.textContent = '加载中…';
    $('brief-content').innerHTML = '';
    fetchJson({ mode: 'brief', day: state.day }).then(function (data) {
      if (!data.brief) {
        st.textContent = '该日暂无简报（采集任务每日 07:30 运行）';
        return;
      }
      st.textContent = '';
      renderBrief(data.brief.markdown || '');
    }).catch(function (e) {
      st.textContent = '加载失败：' + e.message;
    });
  }

  // ---------- 数据加载 ----------
  function loadFeed(reset) {
    if (state.loading) return;
    state.loading = true;
    if (reset) {
      state.page = 1;
      renderSkeleton();
      setState('');
    }
    $('load-more').hidden = true;

    fetchJson({
      day: state.day, lang: state.lang,
      source: state.source, page: state.page, pageSize: state.pageSize,
    }).then(function (data) {
      state.total = data.total;
      var feed = $('feed');
      if (reset) feed.innerHTML = '';
      data.items.forEach(function (item) { feed.appendChild(renderItem(item)); });

      var shown = feed.querySelectorAll('.item').length;
      if (shown === 0) {
        setState('该日暂无收录资讯，可切换到其他日期查看');
      } else {
        setState('共 ' + data.total + ' 条 · 已显示 ' + shown + ' 条');
      }
      $('load-more').hidden = shown >= data.total;
      state.loading = false;
    }).catch(function (e) {
      $('feed').innerHTML = '';
      setState('加载失败：' + e.message, true);
      state.loading = false;
    });
  }

  function loadTop() {
    fetchJson({ mode: 'top', day: state.day })
      .then(function (data) { renderTop(data.items); })
      .catch(function () { $('top-section').hidden = true; });
  }

  function refreshAll() {
    renderNav();
    if (state.view === 'feed') {
      renderChips();
      loadFeed(true);
      loadTop();
    } else {
      loadBrief();
    }
  }

  function switchView(view) {
    state.view = view;
    $('feed-view').hidden = view !== 'feed';
    $('brief-view').hidden = view !== 'brief';
    document.querySelectorAll('#view-tabs .tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.view === view);
    });
    refreshAll();
  }

  // ---------- 事件 ----------
  $('prev-day').onclick = function () { state.day = shiftDay(state.day, -1); refreshAll(); };
  $('next-day').onclick = function () {
    if (state.day < todayShanghai()) { state.day = shiftDay(state.day, 1); refreshAll(); }
  };

  $('load-more').onclick = function () {
    if (state.loading) return;
    state.page += 1;
    state.loading = true;
    fetchJson({
      day: state.day, lang: state.lang,
      source: state.source, page: state.page, pageSize: state.pageSize,
    }).then(function (data) {
      var feed = $('feed');
      data.items.forEach(function (item) { feed.appendChild(renderItem(item)); });
      var shown = feed.querySelectorAll('.item').length;
      setState('共 ' + state.total + ' 条 · 已显示 ' + shown + ' 条');
      $('load-more').hidden = shown >= state.total;
      state.loading = false;
    }).catch(function () {
      state.page -= 1;
      state.loading = false;
    });
  };

  document.querySelectorAll('#view-tabs .tab').forEach(function (tab) {
    tab.addEventListener('click', function () { switchView(tab.dataset.view); });
  });

  document.querySelectorAll('#lang-tabs .tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('#lang-tabs .tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      state.lang = tab.dataset.lang || '';
      loadFeed(true);
    });
  });

  // ---------- 启动 ----------
  $('dateline').textContent = fmtDayCn(todayShanghai()) + ' · 星期' + weekdayCn(todayShanghai());

  if (!API_BASE) {
    setState('尚未配置 API 地址（config.js）');
  } else {
    refreshAll();
  }
})();
