(function () {
  'use strict';

  var TYPE_LABELS = { interview: '面试', written: '笔试', assessment: '测评', other: '其他' };

  // 邮件同步来的日程不强行分类，直接用邮件原文里的事项名称展示
  function eventLabel(ev) {
    if (!ev) return '待补日程';
    return ev.round || TYPE_LABELS[ev.type] || '其他';
  }

  function eventTitle(ev) {
    if (!ev) return '';
    return ev.position ? ev.company + '（' + ev.position + '）' : ev.company;
  }

  function isDeadlineOnly(ev) {
    if (!ev) return false;
    var extra = ev.extra;
    // 待确认卡片里的 extra 还是 JSON 字符串，事件列表里已经解析成对象
    if (typeof extra === 'string') {
      try { extra = JSON.parse(extra || '{}'); } catch (e) { extra = null; }
    }
    return !!(extra && extra.kind === 'deadline');
  }

  /* 带截止的任务：窗口型（结束时间=截止）和纯截止都只占截止前一小时 */
  function deadlineAt(ev) {
    if (!ev || !ev.deadline) return null;
    var m = String(ev.deadline).replace('T', ' ').trim().match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
    if (!m) return null;
    return new Date(m[1] + 'T' + (m[2] || '23:59'));
  }

  function isDeadlineTask(ev) {
    if (!ev || !ev.deadline) return false;
    if (isDeadlineOnly(ev)) return true;
    if (!ev.end_time) return false;
    return (ev.end_date + ' ' + ev.end_time) === String(ev.deadline).replace('T', ' ');
  }

  function taskStart(ev) {
    if (isDeadlineTask(ev)) {
      var due = deadlineAt(ev);
      if (due) return new Date(due.getTime() - 60 * 60 * 1000);
    }
    return eventStart(ev);
  }

  function taskEnd(ev) {
    if (isDeadlineTask(ev)) {
      var due = deadlineAt(ev);
      if (due) return due;
    }
    return eventEnd(ev);
  }

  function taskDate(ev) {
    if (isDeadlineTask(ev)) {
      var due = deadlineAt(ev);
      if (due) return ymd(due);
    }
    return ev.start_date;
  }

  /* 月历用极简称呼：公司简称-事项，如 交行上分-终面 */
  var COMPANY_SHORT = [
    ['中国人寿财产保险', '国寿财险'],
    ['中国人民财产保险', '人保财险'],
    ['中国平安财产保险', '平安产险'],
    ['中国工商银行', '工行'],
    ['中国建设银行', '建行'],
    ['中国农业银行', '农行'],
    ['中国邮政储蓄银行', '邮储'],
    ['上海浦东发展银行', '浦发'],
    ['交通银行', '交行'],
    ['招商银行', '招行'],
    ['浦发银行', '浦发'],
    ['中信银行', '中信'],
    ['民生银行', '民生'],
    ['兴业银行', '兴业'],
    ['光大银行', '光大'],
    ['华夏银行', '华夏'],
    ['平安银行', '平安'],
    ['广发银行', '广发'],
    ['中国银行', '中行'],
    ['中国人寿', '国寿']
  ];

  var CITY_SHORT = {
    '北京': '京', '上海': '上', '天津': '津', '重庆': '渝', '深圳': '深', '广州': '广',
    '杭州': '杭', '南京': '宁', '苏州': '苏', '武汉': '武', '成都': '成', '西安': '镐',
    '长沙': '湘', '郑州': '郑', '济南': '济', '青岛': '青', '合肥': '皖', '福州': '榕',
    '厦门': '厦', '宁波': '甬', '无锡': '锡', '东莞': '莞', '佛山': '佛', '珠海': '珠',
    '昆明': '昆', '贵阳': '贵', '南宁': '邕', '南昌': '赣', '太原': '并', '石家庄': '石',
    '沈阳': '沈', '大连': '大', '长春': '长', '哈尔滨': '哈', '兰州': '兰'
  };

  function companyShort(name) {
    var s = String(name || '').trim();
    if (!s) return '';
    s = s.replace(/股份有限公司|有限责任公司|有限公司/g, '').replace(/集团$/, '');
    var head = s;
    for (var i = 0; i < COMPANY_SHORT.length; i++) {
      if (s.indexOf(COMPANY_SHORT[i][0]) === 0) {
        head = COMPANY_SHORT[i][1];
        s = s.slice(COMPANY_SHORT[i][0].length);
        break;
      }
    }
    var m = s.match(/^([\u4e00-\u9fa5]{2,4}?)市?(分行|分公司|支行|营业部)$/);
    if (m) return head + (CITY_SHORT[m[1]] || m[1].charAt(0)) + '分';
    return head.length > 6 ? head.slice(0, 6) : head;
  }

  function monthText(ev) {
    var label = eventLabel(ev).replace(/^(线上|线下)/, '');
    return companyShort(ev.company) + '-' + label;
  }

  var WEEK_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var SHORT_WEEK = ['一', '二', '三', '四', '五', '六', '日'];
  var STORE_KEY = 'scheduler.theme';
  var VIEW_KEY = 'scheduler.view';
  var VIEWS = ['month', 'week', 'cal'];

  var state = {
    view: 'week',
    anchor: today(),
    query: '',
    searchOpen: false,
    selected: null,
    events: [],
    pending: [],
    source: 'mock',
    editingId: null,
    reminders: [],
    fromDay: false,
    dayReturn: null
  };

  /* ---------- 日期工具 ---------- */
  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function today() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function ymd(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseYmd(s) {
    var p = s.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  function startOfWeek(d) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function weekIndex(dateStr) {
    return (parseYmd(dateStr).getDay() + 6) % 7;
  }

  function eventStart(ev) {
    return new Date(ev.start_date + 'T' + (ev.start_time || '00:00'));
  }

  function eventEnd(ev) {
    if (!ev.end_date || !ev.end_time) return eventStart(ev);
    return new Date(ev.end_date + 'T' + ev.end_time);
  }

  /* ---------- 接口 ---------- */
  function apiFetch(path, options) {
    var opts = options || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ('请求失败（' + res.status + '）'));
        return data;
      });
    });
  }

  function loadEvents() {
    return apiFetch('/api/events').then(function (data) {
      state.events = data.events || [];
      state.source = 'api';
      return state.events;
    }).catch(function () {
      state.source = 'mock';
      if (!state.events.length) {
        state.events = window.MOCK ? window.MOCK.events.slice() : [];
      }
      return state.events;
    });
  }

  function loadConfig() {
    return apiFetch('/api/config').then(function (data) {
      return data.config || null;
    }).catch(function () {
      return null;
    });
  }

  function saveConfig(patch) {
    if (state.source !== 'api') return Promise.resolve();
    return apiFetch('/api/config', { method: 'PATCH', body: JSON.stringify(patch) }).catch(function () {});
  }

  function refreshMeta() {
    if (state.source !== 'api') {
      setPending(window.MOCK ? window.MOCK.pending : 0);
      return;
    }
    apiFetch('/api/meta').then(function (data) {
      setPending(data.pending || 0);
    }).catch(function () {});
  }

  function setPending(n) {
    var badge = document.getElementById('pendingCount');
    badge.textContent = n;
    badge.hidden = !n;
  }

  function subscribe() {
    if (!window.EventSource || state.source !== 'api') return;
    var es = new EventSource('api/events/stream');
    es.addEventListener('changed', function () {
      loadEvents().then(function () {
        refreshMeta();
        loadPending();
        render();
        if (state.selected) {
          var fresh = findEvent(state.selected.id);
          if (fresh) openDrawer(fresh);
          else closeDrawer();
        }
      });
    });
  }

  function findEvent(id) {
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i].id === id) return state.events[i];
    }
    return null;
  }

  /* ---------- 数据筛选 ---------- */
  function searchHay(ev) {
    return [
      ev.company, ev.position, ev.round, ev.location, ev.mode,
      ev.note, ev.link, ev.start_date, ev.end_date, ev.deadline,
      taskDate(ev), TYPE_LABELS[ev.type] || '其他',
      ev.status === 'cancelled' ? '已取消' : ''
    ].join(' ').toLowerCase();
  }

  function visibleEvents() {
    var q = state.query.trim().toLowerCase();
    if (!q) return state.events;
    return state.events.filter(function (ev) {
      return searchHay(ev).indexOf(q) !== -1;
    });
  }

  function matchedEvents() {
    return visibleEvents().slice().sort(function (a, b) {
      return taskStart(a) - taskStart(b);
    });
  }

  function renderSearchResults() {
    var box = document.getElementById('searchResults');
    var q = state.query.trim();
    if (!state.searchOpen || !q) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    var list = matchedEvents();
    box.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = '没有匹配的日程';
      box.appendChild(empty);
    } else {
      list.forEach(function (ev) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'search-result';

        var head = document.createElement('div');
        head.className = 'search-result-head';
        var title = document.createElement('span');
        title.className = 'search-result-title';
        title.textContent = eventTitle(ev) + ' · ' + eventLabel(ev);
        var when = document.createElement('span');
        when.className = 'search-result-when';
        when.textContent = taskDate(ev).slice(5) + ' ' + momentOf(ev);
        head.appendChild(title);
        head.appendChild(when);
        item.appendChild(head);

        if (ev.note) {
          var note = document.createElement('div');
          note.className = 'search-result-note';
          note.textContent = ev.note;
          item.appendChild(note);
        }
        item.addEventListener('click', function () { jumpToEvent(ev); });
        box.appendChild(item);
      });
    }
    box.hidden = false;
  }

  function jumpToEvent(ev) {
    state.searchOpen = false;
    state.anchor = parseYmd(taskDate(ev));
    render();
    openDrawer(ev);
    document.getElementById('searchInput').blur();
  }

  function eventsOn(dateStr) {
    return visibleEvents().filter(function (ev) {
      return taskDate(ev) === dateStr;
    }).sort(function (a, b) {
      return momentOf(a).localeCompare(momentOf(b));
    });
  }

  function momentOf(ev) {
    var d = taskStart(ev);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------- 星期条（仅月视图） ---------- */
  function renderStrip() {
    var strip = document.getElementById('weekStrip');
    strip.innerHTML = '';
    for (var i = 0; i < 7; i++) {
      var cell = document.createElement('div');
      cell.className = 'strip-cell';
      var name = document.createElement('span');
      name.className = 'strip-name';
      name.textContent = SHORT_WEEK[i];
      cell.appendChild(name);
      strip.appendChild(cell);
    }
  }

  /* ---------- 周视图（时间网格） ---------- */
  function hourHeight() {
    var raw = getComputedStyle(document.documentElement).getPropertyValue('--hour-h');
    var n = parseFloat(raw);
    return n > 0 ? n : 56;
  }

  function renderWeek() {
    var grid = document.getElementById('weekGrid');
    grid.innerHTML = '';
    var monday = startOfWeek(state.anchor);
    var now = new Date();
    var H = hourHeight();

    // 表头与时间网格共用同一套列宽，竖线才能严格对齐
    var head = document.createElement('div');
    head.className = 'tg-head';
    var corner = document.createElement('div');
    corner.className = 'tg-head-corner';
    corner.textContent = pad(monday.getMonth() + 1) + '月';
    head.appendChild(corner);

    for (var i = 0; i < 7; i++) {
      var hd = addDays(monday, i);
      var cell = document.createElement('div');
      cell.className = 'tg-head-day' + (sameDay(hd, now) ? ' is-today' : '');

      var nm = document.createElement('span');
      nm.className = 'tg-head-name';
      nm.textContent = SHORT_WEEK[i];

      var dt = document.createElement('span');
      dt.className = 'tg-head-date';
      dt.textContent = hd.getDate();

      var ln = document.createElement('span');
      ln.className = 'tg-head-lunar';
      var lun = window.LUNAR ? window.LUNAR.of(hd) : { dayLabel: '', term: '' };
      if (lun.term) {
        ln.textContent = lun.term;
        ln.classList.add('is-term');
      } else {
        ln.textContent = lun.dayLabel || '';
      }

      cell.appendChild(nm);
      cell.appendChild(dt);
      cell.appendChild(ln);
      head.appendChild(cell);
    }
    grid.appendChild(head);

    var body = document.createElement('div');
    body.className = 'tg-body';

    var hours = document.createElement('div');
    hours.className = 'tg-hours';
    for (var h = 0; h <= 24; h++) {
      var label = document.createElement('div');
      label.className = 'tg-hour' + (h === 24 ? ' is-end' : '');
      label.style.top = (h * H) + 'px';
      label.textContent = h === 24 ? '00' : pad(h);
      hours.appendChild(label);
    }
    body.appendChild(hours);

    var todayIdx = -1;
    for (var i = 0; i < 7; i++) {
      var d = addDays(monday, i);
      var key = ymd(d);
      var col = document.createElement('div');
      col.className = 'tg-day';
      var isToday = sameDay(d, now);
      if (isToday) {
        col.classList.add('is-today');
        todayIdx = i;
      }

      layoutDay(eventsOn(key), H).forEach(function (item) {
        col.appendChild(timeEvent(item));
      });

      col.addEventListener('dblclick', function (dateKey) {
        return function (e) {
          if (e.target.closest('.tg-event')) return;
          var rect = col.getBoundingClientRect();
          var hour = Math.max(0, Math.min(23, Math.floor((e.clientY - rect.top) / H)));
          openEditor(null, dateKey, pad(hour) + ':00');
        };
      }(key));

      body.appendChild(col);
    }

    // 当前时间：整行红线 + 左侧红色时间胶囊
    if (todayIdx >= 0) {
      var topPx = (now.getHours() * 60 + now.getMinutes()) / 60 * H;
      var line = document.createElement('div');
      line.className = 'tg-now';
      line.style.top = topPx + 'px';
      body.appendChild(line);

      var pill = document.createElement('div');
      pill.className = 'tg-now-pill';
      pill.style.top = topPx + 'px';
      pill.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
      hours.appendChild(pill);
    }

    grid.appendChild(body);
    grid.scrollTop = Math.max(0, 7 * H - 8);
  }

  /* 把一天的事件按 Minutes 换算成块，重叠的横向分列 */
  function layoutDay(list, H) {
    var items = list.map(function (ev) {
      var start = taskStart(ev);
      var end = taskEnd(ev);
      var startMin = start.getHours() * 60 + start.getMinutes();
      var endMin = end.getHours() * 60 + end.getMinutes() + (sameDay(start, end) ? 0 : 1440);
      if (endMin <= startMin) endMin = startMin + 60;
      return { ev: ev, start: startMin, end: Math.max(endMin, startMin + 30) };
    }).sort(function (a, b) {
      return a.start - b.start || b.end - a.end;
    });

    var out = [];
    var cluster = [];
    var clusterEnd = -1;

    function flush() {
      var cols = [];
      cluster.forEach(function (it) {
        var idx = 0;
        while (idx < cols.length && cols[idx] > it.start) idx++;
        if (idx === cols.length) cols.push(0);
        cols[idx] = it.end;
        it.col = idx;
      });
      var total = cols.length || 1;
      cluster.forEach(function (it) {
        var height = Math.max((it.end - it.start) / 60 * H - 2, 22);
        out.push({
          ev: it.ev,
          top: it.start / 60 * H,
          height: height,
          left: it.col / total * 100,
          width: 100 / total,
          short: height < 36
        });
      });
      cluster = [];
      clusterEnd = -1;
    }

    items.forEach(function (it) {
      if (cluster.length && it.start >= clusterEnd) flush();
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, it.end);
    });
    flush();
    return out;
  }

  function timeEvent(item) {
    var ev = item.ev;
    var el = document.createElement('article');
    el.className = 'tg-event' + (ev.status === 'cancelled' ? ' is-cancelled' : '') +
      (item.short ? ' is-short' : '');
    if (taskEnd(ev) < new Date() && !sameDay(taskStart(ev), new Date())) el.classList.add('is-past');
    el.style.top = item.top + 'px';
    el.style.height = item.height + 'px';
    el.style.left = 'calc(' + item.left + '% + 2px)';
    el.style.width = 'calc(' + item.width + '% - 5px)';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;

    var title = document.createElement('div');
    title.className = 'tg-event-title';
    // 周视图卡片用「公司-事件名」，公司沿用月历的简称，避免长名字把事件名挤掉
    title.textContent = monthText(ev);

    var meta = document.createElement('div');
    meta.className = 'tg-event-meta';
    if (isDeadlineTask(ev)) {
      var due = deadlineAt(ev);
      meta.textContent = due ? pad(due.getHours()) + ':' + pad(due.getMinutes()) + ' 截止' : '截止';
    } else {
      meta.textContent = ev.start_time || '';
    }

    el.appendChild(title);
    el.appendChild(meta);
    el.addEventListener('click', function () { openDrawer(ev, false); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDrawer(ev, false);
      }
    });
    return el;
  }

  /* ---------- 月视图 ---------- */
  function renderMonth() {
    var grid = document.getElementById('monthGrid');
    grid.innerHTML = '';
    var first = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
    var cursor = startOfWeek(first);
    var now = today();
    var month = state.anchor.getMonth();

    for (var i = 0; i < 42; i++) {
      var d = addDays(cursor, i);
      var key = ymd(d);
      var cell = document.createElement('div');
      cell.className = 'month-cell';
      if (d.getMonth() !== month) cell.classList.add('is-out');
      if (sameDay(d, now)) cell.classList.add('is-today');

      var num = document.createElement('div');
      num.className = 'month-date';
      num.textContent = d.getDate();
      cell.appendChild(num);

      var list = eventsOn(key);
      list.slice(0, 3).forEach(function (ev) {
        cell.appendChild(monthChip(ev));
      });
      if (list.length > 3) {
        var more = document.createElement('div');
        more.className = 'month-more';
        more.textContent = '还有 ' + (list.length - 3) + ' 项';
        cell.appendChild(more);
      }

      cell.addEventListener('click', function (dateKey) {
        return function () { openDayDrawer(dateKey); };
      }(key));

      cell.addEventListener('dblclick', function (dateKey) {
        return function (e) {
          if (e.target.closest('.month-event')) return;
          openEditor(null, dateKey);
        };
      }(key));

      grid.appendChild(cell);
    }
  }

  function monthChip(ev) {
    var chip = document.createElement('div');
    chip.className = 'month-event' + (ev.status === 'cancelled' ? ' is-cancelled' : '');
    chip.textContent = monthText(ev);
    chip.title = monthText(ev);
    return chip;
  }

  /* ---------- 台历 ---------- */
  // 当日传统色按日期缓存，切回来不用重复请求
  var colorCache = {};

  function renderCalendar() {
    var page = document.getElementById('calPage');
    page.innerHTML = '';

    var d = state.anchor;
    var key = ymd(d);
    var lunar = window.LUNAR ? window.LUNAR.of(d) : { label: '', dayLabel: '', term: '' };
    var dayEvents = eventsOn(key);

    var spread = document.createElement('div');
    spread.className = 'cal-spread';

    /* 左：日期画报 */
    var art = document.createElement('article');
    art.className = 'cal-art';
    art.id = 'calArt';

    var head = document.createElement('div');
    head.className = 'cal-art-head';

    var date = document.createElement('div');
    date.className = 'cal-art-date';
    date.textContent = d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
    head.appendChild(date);

    var sideInfo = document.createElement('div');
    sideInfo.className = 'cal-art-side';
    var weekLine = document.createElement('div');
    weekLine.textContent = WEEK_NAMES[weekIndex(key)];
    var lunarLine = document.createElement('div');
    lunarLine.textContent = lunar.term ? lunar.term + ' · ' + lunar.label : lunar.label;
    sideInfo.appendChild(weekLine);
    sideInfo.appendChild(lunarLine);
    head.appendChild(sideInfo);
    art.appendChild(head);

    var foot = document.createElement('div');
    foot.className = 'cal-art-foot';
    art.appendChild(foot);

    /* 右：当天日程 */
    var side = document.createElement('section');
    side.className = 'cal-side';

    var sideHead = document.createElement('div');
    sideHead.className = 'cal-side-head';
    var title = document.createElement('h2');
    title.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    var count = document.createElement('span');
    count.textContent = dayEvents.length ? dayEvents.length + ' 项安排' : '暂无安排';
    sideHead.appendChild(title);
    sideHead.appendChild(count);

    var list = document.createElement('div');
    list.className = 'cal-list';
    if (!dayEvents.length) {
      var empty = document.createElement('div');
      empty.className = 'cal-empty';
      empty.textContent = '这一天还没有日程';
      list.appendChild(empty);
    } else {
      dayEvents.forEach(function (ev) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'cal-item' + (ev.status === 'cancelled' ? ' is-cancelled' : '');

        var time = document.createElement('span');
        time.className = 'cal-item-time';
        time.textContent = momentOf(ev);

        var body = document.createElement('span');
        body.className = 'cal-item-body';
        var name = document.createElement('span');
        name.className = 'cal-item-title';
        name.textContent = eventTitle(ev);
        var sub = document.createElement('span');
        sub.className = 'cal-item-sub';
        sub.textContent = [eventLabel(ev), ev.mode, ev.location].filter(Boolean).join(' · ');
        body.appendChild(name);
        body.appendChild(sub);
        if (ev.note) {
          var note = document.createElement('span');
          note.className = 'cal-item-note';
          note.textContent = ev.note;
          body.appendChild(note);
        }

        item.appendChild(time);
        item.appendChild(body);
        item.addEventListener('click', function () { openDrawer(ev); });
        list.appendChild(item);
      });
    }

    side.appendChild(sideHead);
    side.appendChild(list);
    spread.appendChild(art);
    spread.appendChild(side);
    page.appendChild(spread);
    fillColorCard(foot, art);
  }

  function fillColorCard(box, art) {
    var key = ymd(state.anchor);
    if (colorCache[key]) {
      paintColorCard(box, art, colorCache[key]);
      return;
    }
    if (state.source !== 'api') return;
    apiFetch('/api/daily-color?date=' + key).then(function (data) {
      colorCache[key] = data;
      paintColorCard(box, art, data);
    }).catch(function () { /* 取不到就保留默认底色，不打扰用户 */ });
  }

  function paintColorCard(box, art, data) {
    if (!data || data.kind !== 'cncolor') return;
    art.style.background = data.hex;
    art.style.color = data.ink;
    box.innerHTML = '';

    var name = document.createElement('div');
    name.className = 'cal-art-color';
    name.textContent = data.color;

    var pinyin = document.createElement('div');
    pinyin.className = 'cal-art-pinyin';
    pinyin.textContent = data.pinyin;

    var meta = document.createElement('div');
    meta.className = 'cal-art-meta';
    meta.textContent = data.hex + ' · ' + data.term + '第 ' + data.day_in_term + ' 天';

    var story = document.createElement('p');
    story.className = 'cal-art-story';
    story.textContent = data.text;

    box.appendChild(name);
    box.appendChild(pinyin);
    box.appendChild(meta);
    box.appendChild(story);
  }

  /* ---------- 顶栏 ---------- */
  function renderPeriod() {
    var label = document.getElementById('periodLabel');
    if (state.view === 'cal') {
      label.textContent = state.anchor.getFullYear() + '/' +
        pad(state.anchor.getMonth() + 1) + '/' + pad(state.anchor.getDate());
      return;
    }
    if (state.view === 'week') {
      var monday = startOfWeek(state.anchor);
      var sunday = addDays(monday, 6);
      label.textContent = (monday.getMonth() + 1) + '/' + monday.getDate() + ' - ' +
        (sunday.getMonth() + 1) + '/' + sunday.getDate();
    } else {
      label.textContent = state.anchor.getFullYear() + '/' + pad(state.anchor.getMonth() + 1);
    }
  }

  function render() {
    document.getElementById('weekGrid').hidden = state.view !== 'week';
    document.getElementById('monthGrid').hidden = state.view !== 'month';
    document.getElementById('calPage').hidden = state.view !== 'cal';
    document.getElementById('weekStrip').hidden = state.view !== 'month';
    renderStrip();
    renderPeriod();
    if (state.view === 'week') renderWeek();
    else if (state.view === 'month') renderMonth();
    else renderCalendar();
    renderSearchResults();
  }

  function setView(view) {
    state.view = view;
    syncViewButtons(view);
    render();
  }

  function syncViewButtons(view) {
    Array.prototype.forEach.call(document.querySelectorAll('#viewSwitch button'), function (btn) {
      btn.setAttribute('aria-selected', btn.dataset.view === view ? 'true' : 'false');
    });
  }

  function persistView(view) {
    try { localStorage.setItem(VIEW_KEY, view); } catch (e) { /* 忽略 */ }
    saveConfig({ view: view });
  }

  function readView() {
    try {
      var v = localStorage.getItem(VIEW_KEY);
      if (VIEWS.indexOf(v) !== -1) return v;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function step(dir) {
    if (state.view === 'week') state.anchor = addDays(state.anchor, dir * 7);
    else if (state.view === 'cal') state.anchor = addDays(state.anchor, dir);
    else state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + dir, 1);
    render();
  }

  /* ---------- 抽屉 ---------- */
  function openDrawer(ev, fromDay) {
    state.selected = ev;
    if (fromDay !== undefined) state.fromDay = !!fromDay;
    setDrawerClose(state.fromDay);
    var drawer = document.getElementById('drawer');
    document.getElementById('drawerDay').hidden = true;
    document.getElementById('drawerActions').hidden = false;
    document.getElementById('drawerMeta').hidden = false;
    var type = document.getElementById('drawerType');
    type.className = 'drawer-type';
    type.innerHTML = '';
    var dot = document.createElement('span');
    dot.className = 'dot';
    var text = document.createElement('span');
    text.textContent = eventLabel(ev) + (ev.status === 'cancelled' ? ' · 已取消' : '');
    type.appendChild(dot);
    type.appendChild(text);

    document.getElementById('drawerTitle').textContent = eventTitle(ev);
    document.getElementById('drawerSub').textContent = ev.round || '';

    var start = taskStart(ev);
    var endText = ev.end_time || '';
    var meta = document.getElementById('drawerMeta');
    meta.innerHTML = '';
    var moment;
    if (isDeadlineTask(ev)) {
      var due = deadlineAt(ev);
      var dueDate = due || start;
      moment = (dueDate.getMonth() + 1) + '月' + dueDate.getDate() + '日 ' +
        WEEK_NAMES[weekIndex(ymd(dueDate))] +
        (due ? ' ' + pad(due.getHours()) + ':' + pad(due.getMinutes()) + ' 截止' : ' 截止');
    } else {
      moment = (start.getMonth() + 1) + '月' + start.getDate() + '日 ' +
        WEEK_NAMES[weekIndex(ev.start_date)] +
        ' ' + (ev.start_time || '') + (endText ? ' - ' + endText : '');
    }
    addMeta(meta, '时间', moment);
    addMeta(meta, '形式', ev.mode || '未填写');
    if (ev.location) addMeta(meta, '地点', ev.location);
    if (ev.deadline && !isDeadlineTask(ev)) addMeta(meta, '截止', ev.deadline.replace('T', ' '));
    if (ev.link) {
      var dd = addMeta(meta, '链接', '');
      var a = document.createElement('a');
      a.href = ev.link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '会议链接';
      dd.appendChild(a);
    }
    addMeta(meta, '来源', ev.source === 'mail' ? '邮件同步' : '手动创建');

    var note = document.getElementById('drawerNote');
    if (ev.note) {
      note.hidden = false;
      note.textContent = ev.note;
    } else {
      note.hidden = true;
    }

    document.getElementById('drawerCancel').textContent = ev.status === 'cancelled' ? '恢复' : '标记取消';
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    showScrim();
  }

  function addMeta(dl, label, value) {
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
    return dd;
  }

  function closeDrawer() {
    var drawer = document.getElementById('drawer');
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    state.selected = null;
    state.fromDay = false;
    state.dayReturn = null;
    setDrawerClose(false);
    maybeHideScrim();
  }

  function setDrawerClose(back) {
    var btn = document.getElementById('drawerClose');
    btn.className = back ? 'back-btn' : 'icon-btn';
    btn.title = back ? '返回当天日程' : '关闭';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = back
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg><span>返回</span>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
  }

  /* ---------- 月视图：点日期看当天全部日程 ---------- */
  function openDayDrawer(dateKey) {
    var d = parseYmd(dateKey);
    var list = eventsOn(dateKey);
    state.selected = null;
    state.fromDay = false;
    state.dayReturn = dateKey;
    setDrawerClose(false);

    var drawer = document.getElementById('drawer');
    var type = document.getElementById('drawerType');
    type.className = 'drawer-type';
    type.innerHTML = '';
    var tag = document.createElement('span');
    tag.textContent = '当天日程';
    type.appendChild(tag);

    document.getElementById('drawerTitle').textContent =
      (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_NAMES[weekIndex(dateKey)];
    document.getElementById('drawerSub').textContent = list.length
      ? '共 ' + list.length + ' 项'
      : '这天没有安排';

    document.getElementById('drawerMeta').hidden = true;
    document.getElementById('drawerNote').hidden = true;
    document.getElementById('drawerActions').hidden = true;

    var box = document.getElementById('drawerDay');
    box.hidden = false;
    box.innerHTML = '';
    list.forEach(function (ev) {
      box.appendChild(dayItem(ev));
    });

    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    showScrim();
  }

  function dayItem(ev) {
    var card = document.createElement('article');
    card.className = 'day-item';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    var head = document.createElement('div');
    head.className = 'day-item-head';
    var pill = document.createElement('span');
    pill.className = 'day-pill';
    pill.textContent = eventLabel(ev);
    var time = document.createElement('span');
    time.className = 'day-item-time';
    if (isDeadlineTask(ev)) {
      var due = deadlineAt(ev);
      time.textContent = due ? pad(due.getHours()) + ':' + pad(due.getMinutes()) + ' 截止' : '截止';
    } else {
      time.textContent = (ev.start_time || '全天') + (ev.end_time ? ' - ' + ev.end_time : '');
    }
    head.appendChild(pill);
    head.appendChild(time);

    var title = document.createElement('h3');
    title.className = 'day-item-title';
    title.textContent = eventTitle(ev);

    var meta = document.createElement('dl');
    meta.className = 'meta day-item-meta';
    addMeta(meta, '形式', ev.mode || '未填写');
    if (ev.location) addMeta(meta, '地点', ev.location);
    if (ev.deadline && !isDeadlineTask(ev)) addMeta(meta, '截止', ev.deadline.replace('T', ' '));
    if (ev.status === 'cancelled') addMeta(meta, '状态', '已取消');

    card.appendChild(head);
    card.appendChild(title);
    card.appendChild(meta);

    function open() {
      openDrawer(ev, true);
    }
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open();
    });
    return card;
  }

  /* ---------- 遮罩与面板 ---------- */
  function showScrim() {
    document.getElementById('scrim').hidden = false;
  }

  function maybeHideScrim() {
    var open = ['drawer', 'settingsSheet', 'pendingSheet', 'editorSheet'].some(function (id) {
      return document.getElementById(id).classList.contains('is-open');
    });
    document.getElementById('scrim').hidden = !open;
  }

  function openSettings() {
    fillCredentials(settingsCfg);
    document.getElementById('dataHint').textContent =
      (state.source === 'api' ? '本地数据库已连接。' : '演示数据，未连接本地服务。') +
      '待确认 ' + (document.getElementById('pendingCount').textContent || 0) + ' 条。';
    document.getElementById('settingsSheet').classList.add('is-open');
    document.getElementById('settingsSheet').setAttribute('aria-hidden', 'false');
    refreshAutostart();
    showScrim();
  }

  function refreshAutostart() {
    var box = document.getElementById('autostartToggle');
    if (state.source !== 'api') {
      box.disabled = true;
      return;
    }
    apiFetch('/api/autostart')
      .then(function (data) { box.checked = !!data.enabled; })
      .catch(function () { box.disabled = true; });
  }

  var settingsCfg = null;

  function fillCredentials(cfg) {
    if (cfg) settingsCfg = cfg;
    var src = settingsCfg || {};
    var mail = src.mail || {};
    var ai = src.ai || {};
    document.getElementById('mailUser').value = mail.user || '';
    document.getElementById('mailCode').value = mail.auth_code || '';
    document.getElementById('mailDays').value = mail.sync_mode === 'last'
      ? 'last' : String(mail.initial_days || 7);
    document.getElementById('aiBase').value = ai.base_url || '';
    document.getElementById('aiModel').value = ai.model || '';
    document.getElementById('aiKey').value = ai.api_key || '';
  }

  function collectCredentials() {
    var prev = (settingsCfg && settingsCfg.mail) || {};
    var picked = document.getElementById('mailDays').value;
    var byLast = picked === 'last';
    return {
      mail: {
        user: document.getElementById('mailUser').value.trim(),
        auth_code: document.getElementById('mailCode').value.trim(),
        sync_mode: byLast ? 'last' : 'days',
        // 选「上次同步之后」时保留原来的天数，切回来还能用
        initial_days: byLast ? (Number(prev.initial_days) || 7) : (Number(picked) || 7)
      },
      ai: {
        base_url: document.getElementById('aiBase').value.trim(),
        model: document.getElementById('aiModel').value.trim(),
        api_key: document.getElementById('aiKey').value.trim()
      }
    };
  }

  function saveSettings() {
    var patch = collectCredentials();
    settingsCfg = Object.assign({}, settingsCfg || {}, patch);
    saveConfig(patch);
    closeSettings();
  }

  function closeSettings() {
    document.getElementById('settingsSheet').classList.remove('is-open');
    document.getElementById('settingsSheet').setAttribute('aria-hidden', 'true');
    maybeHideScrim();
  }

  /* ---------- 待确认 ---------- */
  function loadPending() {
    if (state.source !== 'api') {
      state.pending = [];
      renderPending();
      return Promise.resolve();
    }
    return apiFetch('/api/pending').then(function (data) {
      state.pending = data.pending || [];
      renderPending();
      return state.pending;
    }).catch(function () {});
  }

  function pendingMoment(ev) {
    if (!ev || !ev.start_date) return '时间待定';
    if (isDeadlineTask(ev)) {
      var due = deadlineAt(ev);
      if (!due) return '时间待定';
      return (due.getMonth() + 1) + '月' + due.getDate() + '日 ' +
        pad(due.getHours()) + ':' + pad(due.getMinutes()) + ' 截止';
    }
    var d = parseYmd(ev.start_date);
    var span = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    if (ev.start_time) span += ' ' + ev.start_time;
    if (ev.end_time) span += ' - ' + ev.end_time;
    return span;
  }

  function renderPending() {
    var list = document.getElementById('pendingList');
    document.getElementById('pendingToolbar').hidden = !state.pending.length;
    list.innerHTML = '';
    if (!state.pending.length) {
      var empty = document.createElement('div');
      empty.className = 'pending-empty';
      empty.textContent = '暂无待确认的日程。';
      list.appendChild(empty);
      return;
    }
    state.pending.forEach(function (item) {
      list.appendChild(pendingCard(item));
    });
  }

  function pendingCard(item) {
    var payload = item.payload || {};
    var ev = payload.event || null;
    var card = document.createElement('article');
    card.className = 'pending-card';

    var head = document.createElement('div');
    head.className = 'pending-card-head';

    var type = document.createElement('span');
    type.className = 'pending-type';
    var dot = document.createElement('span');
    dot.className = 'dot';
    var typeText = document.createElement('span');
    typeText.textContent = eventLabel(ev);
    type.appendChild(dot);
    type.appendChild(typeText);

    var time = document.createElement('span');
    time.className = 'pending-time';
    time.textContent = ev ? pendingMoment(ev) : '';

    head.appendChild(type);
    head.appendChild(time);
    card.appendChild(head);

    var title = document.createElement('div');
    title.className = 'pending-title';
    title.textContent = ev
      ? eventTitle(ev)
      : (payload.subject || item.subject || '招聘邮件');
    card.appendChild(title);

    var form = ev ? [ev.mode, ev.location].filter(Boolean).join(' · ') : '';
    if (form) {
      var formLine = document.createElement('div');
      formLine.className = 'pending-form';
      formLine.textContent = form;
      card.appendChild(formLine);
    }

    if (ev && ev.note) {
      var noteLine = document.createElement('div');
      noteLine.className = 'pending-note';
      noteLine.textContent = ev.note;
      card.appendChild(noteLine);
    }

    var meta = document.createElement('div');
    meta.className = 'pending-meta';
    meta.textContent = [payload.from_addr || item.from_addr, item.reason].filter(Boolean).join(' · ');
    card.appendChild(meta);

    if (payload.subject && payload.subject !== title.textContent) {
      var subject = document.createElement('div');
      subject.className = 'pending-subject';
      subject.textContent = payload.subject;
      card.appendChild(subject);
    }

    var actions = document.createElement('div');
    actions.className = 'pending-actions';

    var skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'ghost-btn';
    skip.textContent = '忽略';
    skip.addEventListener('click', function () {
      resolvePending(item, 'skip', actions);
    });
    actions.appendChild(skip);

    if (ev) {
      var accept = document.createElement('button');
      accept.type = 'button';
      accept.className = 'solid-btn';
      accept.textContent = '采纳';
      accept.addEventListener('click', function () {
        resolvePending(item, 'accept', actions);
      });
      actions.appendChild(accept);
    }

    card.appendChild(actions);
    return card;
  }

  function resolvePending(item, action, actions) {
    setPendingBusy(actions, true);
    apiFetch('/api/pending/' + encodeURIComponent(item.id) + '/' + action, { method: 'POST' })
      .then(function () { return loadPending(); })
      .then(function () { return loadEvents(); })
      .then(function () {
        render();
        refreshMeta();
      })
      .catch(function (err) {
        setPendingBusy(actions, false);
        setSyncStatus(err.message || '操作失败', true);
      });
  }

  function resolveAllPending(action) {
    if (!state.pending.length) return;
    var toolbar = document.getElementById('pendingToolbar');
    setPendingBusy(toolbar, true);
    setSyncStatus(action === 'skip-all' ? '正在忽略全部…' : '正在采纳全部…');
    apiFetch('/api/pending/' + action, { method: 'POST' })
      .then(function (data) {
        var text = '已处理 ' + (data.done || 0) + ' 条';
        if (data.failed) text += '，' + data.failed + ' 条没有可采纳的日程';
        setSyncStatus(text, !!data.failed);
        return loadPending();
      })
      .then(function () { return loadEvents(); })
      .then(function () {
        render();
        refreshMeta();
      })
      .catch(function (err) {
        setSyncStatus(err.message || '操作失败', true);
      })
      .then(function () { setPendingBusy(toolbar, false); });
  }

  function setPendingBusy(actions, busy) {
    if (!actions) return;
    Array.prototype.forEach.call(actions.querySelectorAll('button'), function (btn) {
      btn.disabled = busy;
    });
  }

  function setSyncStatus(text, isError) {
    var box = document.getElementById('pendingStatus');
    box.textContent = text || '';
    box.classList.toggle('is-error', !!isError);
  }

  function paintSync(st) {
    if (!st) return;
    if (st.running) {
      setSyncStatus('正在同步邮箱并解析新邮件…');
      return;
    }
    if (st.error) {
      setSyncStatus('同步出错：' + st.error, true);
      return;
    }
    if (st.last_at) {
      setSyncStatus('上次同步 ' + st.last_at + ' · 新邮件 ' + (st.fetched || 0) +
        ' 封 · 新增待确认 ' + (st.added || 0) + ' 条');
      return;
    }
    setSyncStatus('还没同步过，点右上角「同步邮箱」。');
  }

  function loadSyncStatus() {
    if (state.source !== 'api') {
      setSyncStatus('演示数据，未连接本地服务。');
      return;
    }
    apiFetch('/api/sync').then(paintSync).catch(function () {});
  }

  function openPending() {
    document.getElementById('pendingSheet').classList.add('is-open');
    document.getElementById('pendingSheet').setAttribute('aria-hidden', 'false');
    showScrim();
    loadPending();
    loadSyncStatus();
  }

  function closePending() {
    document.getElementById('pendingSheet').classList.remove('is-open');
    document.getElementById('pendingSheet').setAttribute('aria-hidden', 'true');
    maybeHideScrim();
  }

  var syncTimer = null;

  function runSync() {
    if (state.source !== 'api') {
      setSyncStatus('演示数据，未连接本地服务。', true);
      return;
    }
    document.getElementById('syncBtn').disabled = true;
    setSyncStatus('正在同步邮箱并解析新邮件…');
    apiFetch('/api/sync', { method: 'POST' })
      .then(function () {
        syncTimer = setTimeout(function () { pollSync(0); }, 600);
      })
      .catch(function (err) {
        document.getElementById('syncBtn').disabled = false;
        setSyncStatus(err.message || '同步失败', true);
      });
  }

  function pollSync(tries) {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    apiFetch('/api/sync').then(function (st) {
      paintSync(st);
      var done = !st.running && (st.last_at || st.error);
      if (!done && tries < 90) {
        syncTimer = setTimeout(function () { pollSync(tries + 1); }, 1200);
        return;
      }
      document.getElementById('syncBtn').disabled = false;
      loadPending().then(function () { return loadEvents(); }).then(function () {
        render();
        refreshMeta();
      });
    }).catch(function () {
      document.getElementById('syncBtn').disabled = false;
    });
  }

  /* ---------- 编辑表单 ---------- */
  function setField(id, value) {
    document.getElementById(id).value = value || '';
  }

  function nextHour(time) {
    var h = parseInt(time.split(':')[0], 10) + 1;
    return pad(Math.min(h, 23)) + ':' + (time.split(':')[1] || '00');
  }

  function openEditor(ev, presetDate, presetStart) {
    state.editingId = ev ? ev.id : null;
    document.getElementById('editorTitle').textContent = ev ? '编辑日程' : '新建日程';
    setField('fType', ev ? ev.type : 'interview');
    setField('fMode', ev ? ev.mode : '线上');
    setField('fCompany', ev ? ev.company : '');
    setField('fLocation', ev ? ev.location : '');
    setField('fPosition', ev ? ev.position : '');
    setField('fRound', ev ? ev.round : '');
    setField('fDate', ev ? ev.start_date : (presetDate || ymd(today())));
    setField('fStart', ev ? ev.start_time : (presetStart || '10:00'));
    setField('fEnd', ev ? ev.end_time : nextHour(presetStart || '10:00'));
    setField('fLink', ev ? ev.link : '');
    setField('fNote', ev ? ev.note : '');
    setField('fDeadline', ev && ev.deadline ? ev.deadline.replace(' ', 'T').slice(0, 16) : '');
    document.getElementById('formError').hidden = true;

    document.getElementById('editorSheet').classList.add('is-open');
    document.getElementById('editorSheet').setAttribute('aria-hidden', 'false');
    showScrim();
    setTimeout(function () { document.getElementById('fCompany').focus(); }, 0);
  }

  function closeEditor() {
    document.getElementById('editorSheet').classList.remove('is-open');
    document.getElementById('editorSheet').setAttribute('aria-hidden', 'true');
    state.editingId = null;
    maybeHideScrim();
  }

  function formError(message) {
    var box = document.getElementById('formError');
    box.textContent = message;
    box.hidden = false;
  }

  function collectForm() {
    var date = document.getElementById('fDate').value;
    var start = document.getElementById('fStart').value;
    var end = document.getElementById('fEnd').value;
    var deadline = document.getElementById('fDeadline').value;
    var payload = {
      type: document.getElementById('fType').value,
      company: document.getElementById('fCompany').value.trim(),
      position: document.getElementById('fPosition').value.trim(),
      round: document.getElementById('fRound').value.trim(),
      start_date: date,
      start_time: start,
      end_date: end ? date : '',
      end_time: end,
      mode: document.getElementById('fMode').value,
      location: document.getElementById('fLocation').value.trim(),
      link: document.getElementById('fLink').value.trim(),
      note: document.getElementById('fNote').value.trim(),
      deadline: deadline ? deadline.replace('T', ' ') : ''
    };
    // 原来只是「截止前完成」的事，手动补了结束时间就当固定时段
    var current = state.editingId ? findEvent(state.editingId) : null;
    if (current && isDeadlineOnly(current) && end) payload.extra = '';
    return payload;
  }

  function saveEvent(event) {
    event.preventDefault();
    var payload = collectForm();
    if (!payload.company) return formError('公司不能为空');
    if (!payload.start_date) return formError('请选择日期');
    if (payload.end_time && !payload.start_time) return formError('填了结束时间也要填开始时间');
    if (payload.end_time && payload.end_time < payload.start_time) return formError('结束时间不能早于开始时间');

    var request;
    if (state.source === 'api') {
      request = state.editingId
        ? apiFetch('/api/events/' + state.editingId, { method: 'PATCH', body: JSON.stringify(payload) })
        : apiFetch('/api/events', { method: 'POST', body: JSON.stringify(payload) });
    } else {
      request = Promise.resolve(saveLocally(payload));
    }

    request.then(function () {
      closeEditor();
      return loadEvents();
    }).then(function () {
      render();
      refreshMeta();
    }).catch(function (err) {
      formError(err.message || '保存失败');
    });
  }

  function saveLocally(payload) {
    if (state.editingId) {
      var existing = findEvent(state.editingId);
      if (existing) Object.assign(existing, payload);
    } else {
      state.events.push(Object.assign({
        id: 'local-' + Date.now(),
        status: 'normal',
        source: 'manual'
      }, payload));
    }
  }

  function mutate(fn) {
    if (state.source === 'api') {
      return fn().then(function () { return loadEvents(); }).then(function () {
        render();
        refreshMeta();
      }).catch(function (err) {
        console.warn(err.message);
      });
    }
    return Promise.resolve();
  }

  /* ---------- 主题 ---------- */
  function buildThemeList() {
    var list = document.getElementById('themeList');
    var current = document.documentElement.getAttribute('data-theme');
    list.innerHTML = '';

    Object.keys(window.SCHEDULER_THEMES).forEach(function (id) {
      var t = window.SCHEDULER_THEMES[id];
      var btn = document.createElement('button');
      btn.className = 'theme-option';
      btn.dataset.themeId = id;
      btn.setAttribute('aria-pressed', id === current ? 'true' : 'false');

      var swatch = document.createElement('span');
      swatch.className = 'theme-swatch';
      ['bg', 'surface-muted', 'brand', 'accent'].forEach(function (key) {
        var s = document.createElement('span');
        s.style.background = '#' + t.color[key];
        swatch.appendChild(s);
      });

      var name = document.createElement('span');
      name.className = 'theme-name';
      name.textContent = t.name;
      var small = document.createElement('small');
      small.textContent = t.mode === 'dark' ? '深色' : '浅色';
      name.appendChild(small);

      btn.appendChild(swatch);
      btn.appendChild(name);
      btn.addEventListener('click', function () {
        chooseTheme(id);
        Array.prototype.forEach.call(list.children, function (el) {
          el.setAttribute('aria-pressed', el.dataset.themeId === id ? 'true' : 'false');
        });
      });

      list.appendChild(btn);
    });
  }

  function chooseTheme(id) {
    if (!window.SCHEDULER_THEMES[id]) return;
    window.applyTheme(id);
    try { localStorage.setItem(STORE_KEY, id); } catch (e) { /* 忽略 */ }
    saveConfig({ theme: id });
  }

  /* ---------- 提醒 ---------- */
  function formatSpan(minutes) {
    if (minutes % 1440 === 0) return (minutes / 1440) + ' 天';
    if (minutes % 60 === 0) return (minutes / 60) + ' 小时';
    return minutes + ' 分钟';
  }

  function reminderLabel(r) {
    if (r.kind === 'days_before') {
      return '提前 ' + r.days + ' 天 ' + (r.time || '18:00');
    }
    return '提前 ' + formatSpan(r.minutes || 0);
  }

  function renderReminders(list) {
    state.reminders = Array.isArray(list) ? list.slice() : [];
    var box = document.getElementById('reminderList');
    box.innerHTML = '';

    if (!state.reminders.length) {
      var empty = document.createElement('div');
      empty.className = 'field-hint';
      empty.textContent = '还没有提醒。';
      box.appendChild(empty);
      return;
    }

    state.reminders.forEach(function (r, index) {
      var row = document.createElement('label');
      row.className = 'reminder-item';

      var check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = r.enabled !== false;
      check.addEventListener('change', function () {
        state.reminders[index].enabled = check.checked;
        persistReminders();
      });

      var text = document.createElement('span');
      text.className = 'reminder-label';
      text.textContent = reminderLabel(r);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'reminder-remove';
      remove.textContent = '删除';
      remove.addEventListener('click', function (e) {
        e.preventDefault();
        state.reminders.splice(index, 1);
        persistReminders();
      });

      row.appendChild(check);
      row.appendChild(text);
      row.appendChild(remove);
      box.appendChild(row);
    });
  }

  function persistReminders() {
    renderReminders(state.reminders);
    saveConfig({ reminders: state.reminders });
  }

  function addReminder() {
    var kind = document.getElementById('reminderKind').value;
    var value = parseInt(document.getElementById('reminderValue').value, 10);
    if (!value || value <= 0) return;

    var item = { id: 'r-' + Date.now().toString(36), enabled: true };
    if (kind === 'days') {
      item.kind = 'days_before';
      item.days = value;
      item.time = document.getElementById('reminderTime').value || '18:00';
    } else {
      item.kind = 'minutes_before';
      item.minutes = value;
    }

    var duplicate = state.reminders.some(function (r) {
      return reminderLabel(r) === reminderLabel(item);
    });
    if (!duplicate) state.reminders.push(item);
    persistReminders();
  }

  /* ---------- 初始化 ---------- */
  var saved = 'paper';
  try { saved = localStorage.getItem(STORE_KEY) || 'paper'; } catch (e) { /* 忽略 */ }
  saved = window.resolveTheme(saved);
  try { localStorage.setItem(STORE_KEY, saved); } catch (e) { /* 忽略 */ }
  window.applyTheme(saved);
  buildThemeList();

  // 打开时回到上次关闭的视图；本地没记到就用配置文件里的
  var savedView = readView();
  if (savedView) {
    state.view = savedView;
    syncViewButtons(savedView);
  }
  render();

  loadEvents().then(function () {
    render();
    refreshMeta();
    subscribe();
    return loadConfig();
  }).then(function (cfg) {
    if (cfg && Array.isArray(cfg.reminders)) renderReminders(cfg.reminders);
    fillCredentials(cfg);
    if (!savedView && cfg && VIEWS.indexOf(cfg.view) !== -1) {
      state.view = cfg.view;
      syncViewButtons(cfg.view);
      render();
    }
    if (cfg && cfg.theme) {
      var applied = window.applyTheme(cfg.theme);
      try { localStorage.setItem(STORE_KEY, applied); } catch (e) { /* 忽略 */ }
      Array.prototype.forEach.call(document.querySelectorAll('.theme-option'), function (el) {
        el.setAttribute('aria-pressed', el.dataset.themeId === applied ? 'true' : 'false');
      });
    }
  });

  /* ---------- 绑定 ---------- */
  document.getElementById('prevBtn').addEventListener('click', function () { step(-1); });
  document.getElementById('nextBtn').addEventListener('click', function () { step(1); });
  document.getElementById('todayBtn').addEventListener('click', function () {
    state.anchor = today();
    render();
  });

  document.getElementById('viewSwitch').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-view]');
    if (!btn) return;
    setView(btn.dataset.view);
    persistView(btn.dataset.view);
  });

  document.getElementById('searchInput').addEventListener('input', function (e) {
    state.query = e.target.value;
    state.searchOpen = true;
    render();
  });

  document.getElementById('searchInput').addEventListener('focus', function () {
    if (!state.query.trim()) return;
    state.searchOpen = true;
    renderSearchResults();
  });

  document.addEventListener('mousedown', function (e) {
    if (!state.searchOpen) return;
    if (e.target.closest('.search-wrap')) return;
    state.searchOpen = false;
    renderSearchResults();
  });

  document.getElementById('reminderAdd').addEventListener('click', addReminder);
  document.getElementById('settingsSave').addEventListener('click', saveSettings);
  document.getElementById('settingsCancel').addEventListener('click', function () {
    fillCredentials(settingsCfg);
    closeSettings();
  });
  document.getElementById('autostartToggle').addEventListener('change', function (e) {
    var wanted = e.target.checked;
    apiFetch('/api/autostart', {
      method: 'POST',
      body: JSON.stringify({ enabled: wanted })
    }).then(function (data) {
      e.target.checked = !!data.enabled;
    }).catch(function () {
      e.target.checked = !wanted;
    });
  });
  document.getElementById('reminderKind').addEventListener('change', function (e) {
    var days = e.target.value === 'days';
    document.getElementById('reminderUnit').textContent = days ? '天' : '分钟';
    document.getElementById('reminderTime').hidden = !days;
    document.getElementById('reminderValue').value = days ? 1 : 15;
  });

  document.getElementById('drawerClose').addEventListener('click', function () {
    if (state.fromDay && state.dayReturn) {
      var key = state.dayReturn;
      closeDrawer();
      openDayDrawer(key);
      return;
    }
    closeDrawer();
  });
  document.getElementById('drawerEdit').addEventListener('click', function () {
    var ev = state.selected;
    if (!ev) return;
    closeDrawer();
    openEditor(ev);
  });

  document.getElementById('drawerCancel').addEventListener('click', function () {
    var ev = state.selected;
    if (!ev) return;
    var next = ev.status === 'cancelled' ? 'normal' : 'cancelled';
    if (state.source === 'api') {
      mutate(function () {
        return apiFetch('/api/events/' + ev.id, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      }).then(closeDrawer);
    } else {
      ev.status = next;
      closeDrawer();
      render();
    }
  });

  document.getElementById('drawerDelete').addEventListener('click', function () {
    var ev = state.selected;
    if (!ev) return;
    if (state.source === 'api') {
      mutate(function () {
        return apiFetch('/api/events/' + ev.id, { method: 'DELETE' });
      }).then(closeDrawer);
    } else {
      state.events = state.events.filter(function (item) { return item.id !== ev.id; });
      closeDrawer();
      render();
    }
  });

  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('pendingBtn').addEventListener('click', openPending);
  document.getElementById('addBtn').addEventListener('click', function () { openEditor(null); });
  document.getElementById('pendingSkipAll').addEventListener('click', function () {
    resolveAllPending('skip-all');
  });
  document.getElementById('pendingAcceptAll').addEventListener('click', function () {
    resolveAllPending('accept-all');
  });
  document.getElementById('pendingClose').addEventListener('click', closePending);
  document.getElementById('syncBtn').addEventListener('click', runSync);
  document.getElementById('settingsClose').addEventListener('click', closeSettings);
  document.getElementById('editorClose').addEventListener('click', closeEditor);
  document.getElementById('editorCancel').addEventListener('click', closeEditor);
  document.getElementById('eventForm').addEventListener('submit', saveEvent);

  document.getElementById('scrim').addEventListener('click', function () {
    closeDrawer();
    closeSettings();
    closePending();
    closeEditor();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (document.getElementById('editorSheet').classList.contains('is-open')) closeEditor();
    else if (document.getElementById('settingsSheet').classList.contains('is-open')) closeSettings();
    else if (document.getElementById('pendingSheet').classList.contains('is-open')) closePending();
    else if (state.searchOpen) {
      state.searchOpen = false;
      renderSearchResults();
    } else closeDrawer();
  });
})();