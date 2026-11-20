// AI 日报前端逻辑 —— 每日简报（精选 10 条 + 星级）/ 历史简报
(function () {
  'use strict';

  var API_BASE = (window.AI_DAILY_CONFIG && window.AI_DAILY_CONFIG.apiBase) || '';
  var API_URL = API_BASE.replace(/\/$/, '') + '/aiDailyApi';

  var state = {
    view: 'daily', // daily | history
    day: todayShanghai(),
    days: [],
    loading: false,
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

  // 年/月/日 时/分（Asia/Shanghai）
  function fmtTime(ts) {
    var d = new Date(ts + 8 * 3600e3);
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getUTCFullYear() + '/' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate() +
      ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
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

  // ---------- 星级（双层裁剪实现半星） ----------
  function renderStars(stars) {
    var wrap = el('span', 'stars');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', '星级 ' + stars + ' / 5');
    var bg = el('span', 'stars-bg', '★★★★★');
    var fg = el('span', 'stars-fg', '★★★★★');
    fg.style.width = (stars / 5 * 100) + '%';
    wrap.appendChild(bg);
    wrap.appendChild(fg);
    wrap.appendChild(el('span', 'stars-num', String(stars)));
    return wrap;
  }

  // ---------- 每日简报渲染 ----------
  function renderReportLine(report) {
    var box = $('pipeline-report');
    if (!report) { box.textContent = ''; return; }
    box.textContent = '采集 ' + report.fetched + ' 条 → 过滤后 ' + report.after_dedup +
      ' 条 → 精选 ' + (report.extracted_ok != null ? '10' : '') + ' 条' +
      ' ｜ 平均可信度 ' + report.avg_credibility + ' ｜ 耗时 ' + report.duration_s + 's';
  }

  function renderBriefItem(item, index) {
    var card = el('article', 'brief-card');

    var head = el('div', 'brief-card-head');
    head.appendChild(el('span', 'brief-rank', String(index + 1).padStart(2, '0')));

    var titleWrap = el('div', 'brief-title-wrap');
    var a = el('a', 'brief-title', item.title);
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener';
    titleWrap.appendChild(a);

    var sub = el('div', 'brief-sub');
    sub.appendChild(renderStars(item.stars || 0));
    if (item.category) {
      var badge = el('span', 'badge cat-badge', item.category);
      badge.style.borderColor = CATEGORY_COLORS[item.category] || '#8a8271';
      badge.style.color = CATEGORY_COLORS[item.category] || '#8a8271';
      sub.appendChild(badge);
    }
    sub.appendChild(el('span', 'badge', item.lang === 'zh' ? '中文' : 'EN'));
    titleWrap.appendChild(sub);
    head.appendChild(titleWrap);
    card.appendChild(head);

    if (item.summary) card.appendChild(el('p', 'brief-summary', item.summary));

    if (item.analysis) {
      var ana = el('p', 'brief-analysis');
      ana.appendChild(el('span', 'ana-label', 'AI 编辑点评'));
      if (item.snark >= 1 && item.snark <= 5) {
        var snark = el('span', 'ana-snark', '🔥'.repeat(item.snark));
        snark.title = '毒舌指数 ' + item.snark + '/5';
        ana.appendChild(snark);
      }
      ana.appendChild(document.createTextNode(item.analysis));
      card.appendChild(ana);
    }

    if (item.entities && item.entities.length) {
      var tags = el('div', 'entities');
      item.entities.slice(0, 6).forEach(function (e) {
        tags.appendChild(el('span', 'entity', e));
      });
      card.appendChild(tags);
    }

    var meta = el('div', 'meta');
    meta.appendChild(el('span', null, item.source));
    meta.appendChild(el('span', null, fmtTime(item.publishedAt)));
    if (item.credibility != null) meta.appendChild(el('span', 'cred', '可信度 ' + item.credibility));
    card.appendChild(meta);
    return card;
  }

  function renderSkeleton() {
    var list = $('brief-list');
    list.innerHTML = '';
    for (var i = 0; i < 4; i++) {
      var s = el('div', 'skeleton');
      s.appendChild(el('div', 'line w60'));
      s.appendChild(el('div', 'line w90'));
      s.appendChild(el('div', 'line w40'));
      list.appendChild(s);
    }
  }

  function setDailyState(text, showRetry) {
    var box = $('daily-state');
    box.innerHTML = '';
    if (text) box.appendChild(document.createTextNode(text));
    if (showRetry) {
      var btn = el('button', 'retry', '重试');
      btn.onclick = function () { loadDaily(); };
      box.appendChild(btn);
    }
  }

  function renderNav() {
    $('current-day').textContent = state.day + ' 周' + weekdayCn(state.day);
    $('next-day').disabled = state.day >= todayShanghai();
    $('day-nav').style.visibility = state.view === 'daily' ? 'visible' : 'hidden';
  }

  // ---------- 数据加载 ----------
  function loadDaily() {
    if (state.loading) return;
    state.loading = true;
    renderSkeleton();
    setDailyState('');
    renderReportLine(null);

    fetchJson({ mode: 'brief', day: state.day }).then(function (data) {
      var list = $('brief-list');
      list.innerHTML = '';
      var brief = data.brief;
      if (!brief || !brief.items || !brief.items.length) {
        setDailyState('该日暂无简报（采集任务每日 07:30 运行）');
        state.loading = false;
        return;
      }
      renderReportLine(brief.report);
      brief.items.forEach(function (item, i) {
        list.appendChild(renderBriefItem(item, i));
      });
      setDailyState('');
      state.loading = false;
    }).catch(function (e) {
      $('brief-list').innerHTML = '';
      renderReportLine(null);
      setDailyState('加载失败：' + e.message, true);
      state.loading = false;
    });
  }

  function loadHistory() {
    var st = $('history-state');
    st.textContent = '加载中…';
    $('history-list').innerHTML = '';
    fetchJson({ mode: 'days' }).then(function (data) {
      state.days = data.days || [];
      st.textContent = '';
      var list = $('history-list');
      list.innerHTML = '';
      if (!state.days.length) {
        st.textContent = '暂无历史简报';
        return;
      }
      state.days.forEach(function (day) {
        var btn = el('button', 'history-item');
        var left = el('span', 'history-day', fmtDayCn(day));
        var right = el('span', 'history-week', '星期' + weekdayCn(day));
        if (day === todayShanghai()) right.appendChild(el('em', 'today-tag', '今天'));
        btn.appendChild(left);
        btn.appendChild(right);
        btn.onclick = function () {
          state.day = day;
          switchView('daily');
        };
        list.appendChild(btn);
      });
    }).catch(function (e) {
      st.textContent = '加载失败：' + e.message;
    });
  }

  function switchView(view) {
    state.view = view;
    $('daily-view').hidden = view !== 'daily';
    $('history-view').hidden = view !== 'history';
    document.querySelectorAll('#view-tabs .tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.view === view);
    });
    renderNav();
    if (view === 'daily') loadDaily();
    else loadHistory();
  }

  // ---------- 事件 ----------
  $('prev-day').onclick = function () { state.day = shiftDay(state.day, -1); renderNav(); loadDaily(); };
  $('next-day').onclick = function () {
    if (state.day < todayShanghai()) { state.day = shiftDay(state.day, 1); renderNav(); loadDaily(); }
  };

  document.querySelectorAll('#view-tabs .tab').forEach(function (tab) {
    tab.addEventListener('click', function () { switchView(tab.dataset.view); });
  });

  // ---------- 启动 ----------
  $('dateline').textContent = fmtDayCn(todayShanghai()) + ' · 星期' + weekdayCn(todayShanghai());

  if (!API_BASE) {
    setDailyState('尚未配置 API 地址（config.js）');
  } else {
    renderNav();
    loadDaily();
  }
})();
