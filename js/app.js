/* 歴史散策ウォーキングツアー — app.js（ビルド不要のプレーンJS）
 * 都市ごとのデータは data/<都市id>/ にあり、data/cities.json に都市の一覧があります。 */
(function () {
  'use strict';

  // ---------- 設定 ----------
  var TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var TILE_CACHE = 'gt-tiles-v1';
  var TILE_LIMIT = 250; // OSMタイル利用規約：ズーム13以上で250枚超の一括取得は禁止
  var PROX_M = 50;
  var WALK_M_PER_MIN = 75;
  var LS = 'gt.';
  var RATES = [0.75, 1, 1.25, 1.5];

  // ---------- 状態 ----------
  var S = {
    cities: [], city: null, cityId: load('city', null),
    data: null, glossary: [], info: [], timeline: null, spots: {},
    mode: load('mode', 'adult'),
    prox: load('prox', false),
    rate: load('rate', 1),
    kidName: load('kidName', ''),
    courseId: 'A', idx: {}, visited: {}, murals: {}, certs: {},
    pos: null, heading: null, watchId: null,
    alerted: {}, map: null, layers: {}, meMarker: null, meCircle: null,
    currentSheet: null, tab: 'map', learnTab: 'timeline',
    audio: { sents: [], i: 0, playing: false, token: 0 }
  };

  // ---------- ユーティリティ ----------
  function load(k, d) { try { var v = localStorage.getItem(LS + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* private mode etc. */ } }
  // 都市ごとの保存（訪問記録など）
  function cload(k, d) { return load(S.cityId + '.' + k, d); }
  function csave(k, v) { save(S.cityId + '.' + k, v); }
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // こども用テキスト：ruby / rt / rp タグだけを許可
  function safeRuby(s) { return esc(s).replace(/&lt;(\/?)(ruby|rt|rp)&gt;/g, '<$1$2>'); }
  // 読み上げ用：ルビはよみがなに置き換え、タグを除去
  function speechText(html) { return String(html).replace(/<ruby>(.*?)<rt>(.*?)<\/rt><\/ruby>/g, '$2').replace(/<[^>]+>/g, ''); }
  // 文ごとに分割（。！？で区切る。タグの途中では区切らない）
  function splitSentences(s) { return (String(s).match(/[^。！？]+[。！？」）]*|[。！？]+/g) || []).map(function (x) { return x.trim(); }).filter(Boolean); }
  function kids() { return S.mode === 'kids'; }
  function course() { return S.data.courses.filter(function (c) { return c.id === S.courseId; })[0] || S.data.courses[0]; }
  function curIdx() {
    var c = course(); var i = S.idx[c.id];
    if (i == null) { i = 0; while (i < c.stops.length - 1 && c.stops[i].optional) i++; } // 初期値は寄り道を飛ばした最初のスポット
    return Math.min(Math.max(i, 0), c.stops.length - 1);
  }
  function setIdx(i) { S.idx[course().id] = i; csave('idx', S.idx); }
  function stopNo(c, id) { for (var i = 0; i < c.stops.length; i++) if (c.stops[i].id === id) return i + 1; return null; }
  function eraById(id) { return S.timeline && S.timeline.eras.filter(function (e) { return e.id === id; })[0]; }

  function dist(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  function bearing(a, b) {
    var toR = Math.PI / 180;
    var y = Math.sin((b.lng - a.lng) * toR) * Math.cos(b.lat * toR);
    var x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lng - a.lng) * toR);
    return (Math.atan2(y, x) / toR + 360) % 360;
  }
  function dirName(deg) {
    var adult = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
    var kid = ['きた', 'きたひがし', 'ひがし', 'みなみひがし', 'みなみ', 'みなみにし', 'にし', 'きたにし'];
    return (kids() ? kid : adult)[Math.round(deg / 45) % 8];
  }
  function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + 'm' : (m / 1000).toFixed(1) + 'km'; }
  function fmtMin(m) { return m >= 60 ? Math.floor(m / 60) + '時間' + (m % 60 ? (m % 60) + '分' : '') : m + '分'; }
  function getJSON(url, optional) {
    return fetch(url).then(function (r) {
      if (!r.ok) { if (optional) return null; throw new Error(url + ' ' + r.status); }
      return r.json();
    }).catch(function (e) { if (optional) return null; throw e; });
  }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }

  // ---------- 起動 ----------
  function init() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW登録失敗', e); });
      });
    }
    getJSON('data/cities.json').then(function (d) {
      S.cities = d.cities || [];
      bindUI();
      initMap();
      renderCityPicker();
      var known = S.cities.some(function (c) { return c.id === S.cityId; });
      if (known) return loadCity(S.cityId);
      showCityPicker(true);
    }).catch(fatal);
  }
  function fatal(e) {
    console.error(e);
    $('#main').innerHTML = '<div class="pad"><div class="card">データを読み込めませんでした。オンラインの状態で一度開いてください。<br><small>' + esc(e.message) + '</small></div></div>';
  }

  // ---------- 都市の選択と読み込み ----------
  function renderCityPicker() {
    $('#cityList').innerHTML = S.cities.map(function (c) {
      return '<button class="city-card" data-act="city" data-id="' + esc(c.id) + '">' +
        (c.cover ? '<img src="' + esc(c.cover) + '" alt="" loading="lazy">' : '') +
        '<span class="city-name">' + esc(c.name) + '</span><span class="city-sub">' + esc(c.sub) + '</span></button>';
    }).join('');
  }
  function showCityPicker(first) {
    $('#cityPicker').hidden = false;
    $('#cityPickerClose').hidden = !!first || !S.data;
  }
  function loadCity(id) {
    var city = S.cities.filter(function (c) { return c.id === id; })[0];
    if (!city) return Promise.resolve();
    stopAudio(); closeSheet(); closeModal();
    var base = 'data/' + city.id + '/';
    return Promise.all([getJSON(base + 'spots.json'), getJSON(base + 'glossary.json'), getJSON(base + 'info.json'), getJSON(base + 'timeline.json', true)]).then(function (res) {
      S.city = city; S.cityId = city.id; save('city', city.id);
      migrateLegacy();
      S.data = res[0]; S.glossary = (res[1] && res[1].terms) || []; S.info = (res[2] && res[2].sections) || []; S.timeline = res[3];
      S.spots = {}; S.data.spots.forEach(function (s) { S.spots[s.id] = s; });
      S.courseId = cload('course', S.data.courses[0].id);
      if (!S.data.courses.some(function (c) { return c.id === S.courseId; })) S.courseId = S.data.courses[0].id;
      S.idx = cload('idx', {}); S.visited = cload('visited', {}); S.murals = cload('murals', {}); S.certs = cload('certs', {});
      S.alerted = {};
      $('#cityPicker').hidden = true;
      $('#cityBtnName').textContent = city.name;
      if (S.map) S.map.setView(city.center, 16);
      applyMode();
      renderGlossary(); renderInfo(); renderAbout(); renderLearn(); updateTileInfo();
      setTimeout(fitCourse, 120);
      if (load('geo', false)) startGeo(false);
    }).catch(fatal);
  }
  // 旧バージョン（ペナンのみ）の記録を引き継ぐ
  function migrateLegacy() {
    if (S.cityId !== 'penang' || load('penang.visited', null) !== null) return;
    ['visited', 'idx', 'murals', 'certs', 'course'].forEach(function (k) {
      var v = load(k, null);
      if (v !== null) { csave(k, v); try { localStorage.removeItem(LS + k); } catch (e) { /* ignore */ } }
    });
  }

  // ---------- UI結線 ----------
  function bindUI() {
    $all('.mode-switch button').forEach(function (b) {
      b.addEventListener('click', function () { S.mode = b.dataset.mode; save('mode', S.mode); applyMode(); });
    });
    $all('.tabbar button').forEach(function (b) {
      b.addEventListener('click', function () { showTab(b.dataset.tab); });
    });
    $('#cityBtn').addEventListener('click', function () { showCityPicker(false); });
    $('#cityPickerClose').addEventListener('click', function () { $('#cityPicker').hidden = true; });
    $('#btnLocate').addEventListener('click', function () {
      if (S.pos) { S.map.setView([S.pos.lat, S.pos.lng], Math.max(S.map.getZoom(), 17)); }
      startGeo(true);
    });
    $('#btnFit').addEventListener('click', fitCourse);
    $('#sheetClose').addEventListener('click', closeSheet);
    $('#sheetSpeak').addEventListener('click', togglePlay);
    $('#toggleProx').checked = !!S.prox;
    $('#toggleProx').addEventListener('change', function (e) {
      S.prox = e.target.checked; save('prox', S.prox);
      if (S.prox) { startGeo(true); toast('スポットの約50m以内に近づくとお知らせします'); }
    });
    $('#btnTiles').addEventListener('click', downloadTiles);
    $('#btnTilesClear').addEventListener('click', clearTiles);
    $('#btnReset').addEventListener('click', function () {
      if (!confirm(S.city.name + 'の訪問済み・スタンプなどの記録を消しますか？')) return;
      S.visited = {}; S.murals = {}; S.certs = {}; S.idx = {};
      csave('visited', S.visited); csave('murals', S.murals); csave('certs', S.certs); csave('idx', S.idx);
      renderAllDynamic(); renderLearn(); toast('記録を消しました');
    });
    $('#glossarySearch').addEventListener('input', renderGlossary);
    $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal') closeModal(); });

    // 動的に生成されるボタンはイベント委譲で処理
    document.body.addEventListener('click', function (e) {
      var sent = e.target.closest('.sent[data-si]');
      if (sent && $('#sheet').contains(sent) && S.audio.sents.length) { playFrom(+sent.dataset.si); return; }
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var act = el.dataset.act, id = el.dataset.id;
      if (act === 'open') openSpot(id);
      else if (act === 'listen') { $('#proxBanner').hidden = true; openSpot(id); playFrom(0); }
      else if (act === 'visit') toggleVisited(id);
      else if (act === 'next') nextStop();
      else if (act === 'prev') { setIdx(Math.max(0, curIdx() - 1)); renderAllDynamic(); }
      else if (act === 'goto') { setIdx(+el.dataset.i); renderAllDynamic(); }
      else if (act === 'course') { S.courseId = id; csave('course', id); renderAllDynamic(); fitCourse(); }
      else if (act === 'city') loadCity(id);
      else if (act === 'quiz') { var a = el.parentNode.querySelector('.a'); a.hidden = !a.hidden; el.textContent = a.hidden ? 'こたえを見る' : 'こたえをかくす'; }
      else if (act === 'mural') toggleMural(id);
      else if (act === 'showmap') { closeSheet(); closeModal(); showTab('map'); S.map.setView([+el.dataset.lat, +el.dataset.lng], 18); }
      else if (act === 'compass') enableCompass();
      else if (act === 'closemodal') closeModal();
      else if (act === 'cert') showCert(id);
      else if (act === 'adultview') { S.forceAdultDetail = !S.forceAdultDetail; openSpot(S.currentSheet); }
      else if (act === 'prox-close') $('#proxBanner').hidden = true;
      else if (act === 'locate') startGeo(true);
      else if (act === 'learn') { S.learnTab = id; renderLearn(); }
      else if (act === 'era') { closeSheet(); showTab('learn'); S.learnTab = 'timeline'; renderLearn(); var t = document.getElementById('era-' + id); if (t) t.scrollIntoView({ block: 'start' }); }
      else if (act === 'play') togglePlay();
      else if (act === 'aprev') playFrom(Math.max(0, S.audio.i - 1));
      else if (act === 'anext') playFrom(Math.min(S.audio.sents.length - 1, S.audio.i + 1));
      else if (act === 'rate') cycleRate();
    });
  }

  function showTab(tab) {
    S.tab = tab;
    $all('.view').forEach(function (v) { v.hidden = v.dataset.view !== tab; });
    $all('.tabbar button').forEach(function (b) { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (tab === 'map' && S.map) setTimeout(function () { S.map.invalidateSize(); }, 50);
  }

  function applyMode() {
    document.body.classList.toggle('kids', kids());
    $all('.mode-switch button').forEach(function (b) { b.setAttribute('aria-checked', String(b.dataset.mode === S.mode)); });
    $all('.tabbar .tl').forEach(function (t) { t.textContent = kids() ? t.dataset.kids : t.dataset.adult; });
    if (S.city) {
      $('#appTitle').textContent = kids() ? S.city.kids_title : S.city.title;
      document.title = S.city.title;
    }
    S.forceAdultDetail = false;
    if (!S.data) return;
    renderAllDynamic();
    renderLearn();
    if (S.currentSheet) openSpot(S.currentSheet);
  }

  function renderAllDynamic() {
    renderTour();
    renderMapLayers();
    renderNav();
  }

  // ---------- 地図 ----------
  function initMap() {
    var map = L.map('map', { zoomControl: false, tap: true }).setView([5.4175, 100.3390], 16);
    L.control.zoom({ position: 'topleft' }).addTo(map);
    L.tileLayer(TILE_URL, {
      maxZoom: 19, minZoom: 12,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      crossOrigin: true
    }).addTo(map);
    S.map = map;
    S.layers.route = L.layerGroup().addTo(map);
    S.layers.pins = L.layerGroup().addTo(map);
    S.layers.murals = L.layerGroup().addTo(map);
  }

  function renderMapLayers() {
    if (!S.map || !S.data) return;
    var c = course(), cur = curIdx();
    S.layers.route.clearLayers(); S.layers.pins.clearLayers(); S.layers.murals.clearLayers();
    if (c.route && c.route.line) {
      L.polyline(c.route.line, { color: '#ffffff', weight: 9, opacity: .9 }).addTo(S.layers.route);
      L.polyline(c.route.line, { color: kids() ? '#d4560b' : '#0b5d63', weight: 5, opacity: .95 }).addTo(S.layers.route);
    }
    var inCourse = {};
    c.stops.forEach(function (st, i) {
      var s = S.spots[st.id]; if (!s) return;
      inCourse[st.id] = true;
      var cls = 'num-pin' + (S.visited[st.id] ? ' visited' : '') + (st.optional ? ' optional' : '') + (i === cur ? ' current' : '');
      var icon = L.divIcon({ className: '', html: '<div class="' + cls + '">' + (S.visited[st.id] ? '✓' : (i + 1)) + '</div>', iconSize: [32, 32], iconAnchor: [16, 16] });
      L.marker([s.lat, s.lng], { icon: icon, title: s.name.ja, zIndexOffset: i === cur ? 1000 : 0 })
        .bindPopup(popupHtml(s, i + 1, st))
        .addTo(S.layers.pins);
    });
    // コース外のスポットも小さく表示（全スポットのピン）
    S.data.spots.forEach(function (s) {
      if (inCourse[s.id]) return;
      var icon = L.divIcon({ className: '', html: '<div class="num-pin other">•</div>', iconSize: [24, 24], iconAnchor: [12, 12] });
      L.marker([s.lat, s.lng], { icon: icon, title: s.name.ja }).bindPopup(popupHtml(s, null)).addTo(S.layers.pins);
    });
    // こどもモード：壁画さがしのピン（murals を持つスポットがある都市のみ）
    if (kids()) {
      S.data.spots.forEach(function (sp) {
        (sp.murals || []).forEach(function (m) {
          var icon = L.divIcon({ className: '', html: '<div class="mural-pin' + (S.murals[m.id] ? ' found' : '') + '">🎨</div>', iconSize: [24, 24], iconAnchor: [12, 12] });
          L.marker([m.lat, m.lng], { icon: icon, title: m.name })
            .bindPopup('<strong>' + safeRuby(m.hint_ja) + '</strong><br><small>' + esc(m.name) + '</small><br><button class="btn small popup-btn" data-act="mural" data-id="' + esc(m.id) + '">' + (S.murals[m.id] ? 'みつけた！✓' : 'みつけた！') + '</button>')
            .addTo(S.layers.murals);
        });
      });
    }
  }

  function popupHtml(s, n, st) {
    return '<strong>' + (n ? n + '. ' : '') + esc(s.name.ja) + '</strong><br><small>' + esc(s.summary || '') + '</small>' +
      (st && st.optional ? '<br><small>（寄り道）</small>' : '') +
      '<br><button class="btn small primary popup-btn" data-act="open" data-id="' + esc(s.id) + '">' + (kids() ? 'くわしく見る' : '詳しく見る') + '</button>';
  }

  function fitCourse() {
    if (!S.map || !S.data) return;
    var c = course(), pts = c.stops.map(function (st) { var s = S.spots[st.id]; return [s.lat, s.lng]; });
    if (c.route && c.route.line) pts = pts.concat(c.route.line);
    var card = $('#mapNext'), ch = card ? card.offsetHeight : 0;
    if (pts.length) S.map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [20, 20], paddingBottomRight: [20, ch + 20], maxZoom: 17 });
  }

  // ---------- 現在地 ----------
  function startGeo(userAction) {
    if (!('geolocation' in navigator)) { if (userAction) toast('この端末では現在地を取得できません'); return; }
    if (S.watchId !== null) return;
    S.watchId = navigator.geolocation.watchPosition(function (p) {
      save('geo', true);
      var first = !S.pos;
      S.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      if (p.coords.heading != null && !isNaN(p.coords.heading) && p.coords.speed > 0.5 && !S.compassOn) S.heading = p.coords.heading;
      drawMe();
      renderNav();
      checkProximity();
      $('#btnLocate').classList.add('active');
      if (first && userAction) S.map.setView([S.pos.lat, S.pos.lng], 17);
    }, function (err) {
      S.watchId = null;
      $('#btnLocate').classList.remove('active');
      if (userAction || err.code === 1) toast(err.code === 1 ? '位置情報の利用が許可されていません（iPhoneの設定 > プライバシーとセキュリティ > 位置情報サービス > Safariのサイト で許可できます）' : '現在地を取得できませんでした', 4000);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  function drawMe() {
    if (!S.map || !S.pos) return;
    var ll = [S.pos.lat, S.pos.lng];
    if (!S.meMarker) {
      S.meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 2000, interactive: false }).addTo(S.map);
      S.meCircle = L.circle(ll, { radius: S.pos.acc, color: '#1a73e8', weight: 1, fillOpacity: .1, interactive: false }).addTo(S.map);
    } else { S.meMarker.setLatLng(ll); S.meCircle.setLatLng(ll).setRadius(S.pos.acc); }
  }

  // コンパス（iOSは許可が必要）
  function enableCompass() {
    function handler(e) {
      var h = null;
      if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
      else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;
      if (h !== null) { S.heading = h; S.compassOn = true; renderNavArrowOnly(); }
    }
    function attach() {
      window.addEventListener('deviceorientationabsolute', handler, true);
      window.addEventListener('deviceorientation', handler, true);
      toast(kids() ? 'やじるしが、すすむほうこうをさすよ' : 'コンパスON：矢印が進む方向を指します');
    }
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(function (r) { if (r === 'granted') attach(); else toast('コンパスの利用が許可されませんでした'); }).catch(function () { toast('コンパスを使えませんでした'); });
    } else if (window.DeviceOrientationEvent) attach();
    else toast('この端末ではコンパスを使えません');
  }

  // ---------- 次のスポットまでの距離・方角 ----------
  function navHtml(compact) {
    var c = course(), i = curIdx(), st = c.stops[i], s = S.spots[st.id];
    var allDone = c.stops.every(function (x) { return x.optional || S.visited[x.id]; });
    var label = allDone ? (kids() ? 'コースぜんぶクリア！' : 'コース完了！') : (kids() ? 'つぎのスポット' : '次のスポット');
    var distLine, rot = 0;
    if (S.pos) {
      var d = dist(S.pos, s), b = bearing(S.pos, s);
      rot = S.heading != null ? (b - S.heading + 360) % 360 : b;
      distLine = 'あと ' + fmtDist(d) + '・' + dirName(b) + (kids() ? 'のほう' : '方向') +
        (st.leg && d > 1500 ? '（' + esc((st.leg.modes || []).join('・')) + 'で移動）' : '（徒歩約' + Math.max(1, Math.round(d / WALK_M_PER_MIN)) + '分）');
    } else {
      distLine = '<button class="btn small" data-act="locate">現在地をONにして距離を表示</button>';
    }
    var arrow = '<div class="nav-arrow" data-act="compass" title="タップでコンパス" aria-label="方角（タップでコンパス）"><span class="navArrow" style="transform:rotate(' + rot.toFixed(0) + 'deg)">' + (S.pos ? '↑' : '?') + '</span></div>';
    if (compact) return '<div class="nav-mini">' + arrow + '<div class="nav-dist">' + distLine + '</div></div>';
    return '<div class="nav-card">' + arrow +
      '<div><div class="nav-label">' + label + '（' + (i + 1) + '/' + c.stops.length + '）' + (st.optional ? ' 寄り道' : '') + '</div>' +
      '<div class="nav-name">' + esc(s.name.ja) + '</div>' +
      '<div class="nav-dist">' + distLine + '</div></div>' +
      '<div class="nav-actions"><button class="btn" data-act="open" data-id="' + esc(s.id) + '">' + (kids() ? 'おはなし' : '解説') + '</button>' +
      '<button class="btn primary" data-act="next">' + (S.visited[s.id] ? (kids() ? 'つぎへ ▶' : '次へ ▶') : (kids() ? 'ついた！つぎへ ▶' : '訪問済みにして次へ ▶')) + '</button></div>' +
      '</div>';
  }
  function renderNav() {
    if (!S.data) return;
    $('#mapNext').innerHTML = navHtml(false);
    var tn = $('#tourNav'); if (tn) tn.innerHTML = navHtml(true);
  }
  function renderNavArrowOnly() {
    if (!S.pos || !S.data) return;
    var c = course(), s = S.spots[c.stops[curIdx()].id];
    var rot = (bearing(S.pos, s) - (S.heading || 0) + 360) % 360;
    $all('.navArrow').forEach(function (a) { a.style.transform = 'rotate(' + rot.toFixed(0) + 'deg)'; });
  }

  // ---------- 近接通知 ----------
  function checkProximity() {
    if (!S.prox || !S.pos || !S.data) return;
    var now = Date.now(), near = null, nd = Infinity;
    S.data.spots.forEach(function (s) {
      var d = dist(S.pos, s);
      if (d <= PROX_M && d < nd && (!S.alerted[s.id] || now - S.alerted[s.id] > 15 * 60 * 1000)) { near = s; nd = d; }
    });
    if (!near) return;
    S.alerted[near.id] = now;
    var b = $('#proxBanner');
    b.innerHTML = '<span>📍</span><span class="grow">' + (kids() ? 'ちかくに「' : '近くに「') + esc(near.name.ja) + (kids() ? '」があるよ！' : '」があります') + '（約' + Math.round(nd) + 'm）</span>' +
      '<button data-act="listen" data-id="' + esc(near.id) + '" aria-label="音声ガイドを聞く">▶ ' + (kids() ? 'きく' : '聞く') + '</button>' +
      '<button data-act="open" data-id="' + esc(near.id) + '">' + (kids() ? 'ひらく' : '開く') + '</button><button class="x" data-act="prox-close" aria-label="閉じる">✕</button>';
    b.hidden = false;
    if (navigator.vibrate) navigator.vibrate(200);
    clearTimeout(S.proxTimer); S.proxTimer = setTimeout(function () { b.hidden = true; }, 30000);
  }

  // ---------- ツアー ----------
  function renderTour() {
    var c = course(), cur = curIdx();
    $('#courseChips').innerHTML = S.data.courses.map(function (x) {
      return '<button class="chip" role="tab" aria-selected="' + (x.id === c.id) + '" data-act="course" data-id="' + esc(x.id) + '">' + esc(x.short || x.name) + '</button>';
    }).join('');
    var req = c.stops.filter(function (x) { return !x.optional; });
    var done = req.filter(function (x) { return S.visited[x.id]; }).length;
    var stay = req.reduce(function (a, x) { return a + (x.stay_min || 0); }, 0);
    $('#courseInfo').innerHTML = '<h2>' + esc(c.name) + '</h2>' +
      '<div class="meta-line"><span class="pill">⏱ ' + esc(c.duration_label) + '</span><span class="pill">' + esc(c.walk_note || '') + '</span><span class="pill">滞在の目安 計' + fmtMin(stay) + '</span></div>' +
      (c.best_time ? '<p class="best-time">🕗 <strong>' + (kids() ? 'おすすめの時間' : 'おすすめの時間帯') + '</strong>：' + esc(c.best_time) + '</p>' : '') +
      (c.start ? '<p class="small-text">🚩 ' + esc(c.start) + '</p>' : '') +
      '<p>' + esc(c.description) + '</p>' +
      (kids() && c.kids_guide ? kidsGuideHtml(c.kids_guide) : '') +
      '<p class="progress-text">' + (kids() ? 'スタンプ ' : '訪問済み ') + done + ' / ' + req.length + '</p>';

    var st = c.stops[cur], s = S.spots[st.id];
    $('#tourNow').innerHTML = '<div class="card now-card">' +
      '<div class="now-label">' + (kids() ? 'いまのもくてきち' : '現在の目的地') + '　' + (cur + 1) + ' / ' + c.stops.length + (st.optional ? '（寄り道）' : '') + '</div>' +
      '<h3>' + esc(s.name.ja) + '</h3>' +
      '<p class="summary">' + esc(s.summary) + (st.note ? '<br><small>' + esc(st.note) + '</small>' : '') + '</p>' +
      '<div id="tourNav"></div>' +
      '<div class="btn-row"><button class="btn" data-act="open" data-id="' + esc(s.id) + '" style="flex:1">' + (kids() ? 'おはなしを読む' : '解説を読む') + '</button>' +
      '<button class="btn" data-act="listen" data-id="' + esc(s.id) + '">▶ ' + (kids() ? 'きく' : '聞く') + '</button></div>' +
      '<div class="now-nav"><button class="btn" data-act="prev" ' + (cur === 0 ? 'disabled' : '') + '>◀ ' + (kids() ? 'もどる' : '前へ') + '</button>' +
      '<button class="btn primary big" data-act="next">' + (kids() ? 'ついた！つぎへ ▶' : '次へ ▶') + '</button></div>' +
      (st.leg ? '<div class="leg-box"><div class="leg-h">' + (kids() ? 'ここへの行きかた' : 'ここへの行き方') + '</div>' + legHtml(st.leg) + '</div>' :
        (c.transport ? '<p class="small-text">🚗 ' + esc(s.transport || c.walk_note) + '</p>' : '')) +
      (st.best_time ? '<p class="small-text">🕗 おすすめ：' + esc(st.best_time) + '</p>' : '') +
      '</div>';

    $('#stampPanel').innerHTML = kids() ? stampPanelHtml(c) : '';

    $('#stopListTitle').textContent = kids() ? 'ルート（タップでくわしく）' : 'ルート（タップで詳細）';
    var legs = (c.route && c.route.legs_m) || [];
    var html = '';
    c.stops.forEach(function (x, i) {
      var sp = S.spots[x.id]; if (!sp) return;
      if (x.leg) html += '<li class="leg leg-transit">' + legHtml(x.leg, true) + '</li>';
      else if (i > 0 && legs[i - 1] != null) html += '<li class="leg">↓ 徒歩 約' + fmtDist(legs[i - 1]) + '（' + Math.max(1, Math.round(legs[i - 1] / WALK_M_PER_MIN)) + '分）</li>';
      else if (i > 0 && c.transport) html += '<li class="leg">↓ ' + (sp.transport && /Grab/.test(sp.transport) ? 'Grabで移動' : '移動') + '</li>';
      html += '<li class="stop' + (i === cur ? ' is-current' : '') + (S.visited[x.id] ? ' is-visited' : '') + (x.optional ? ' is-optional' : '') + '">' +
        '<button class="num" data-act="goto" data-i="' + i + '" aria-label="' + (i + 1) + '番を目的地にする" style="border:0;cursor:pointer">' + (i + 1) + '</button>' +
        '<button class="stop-open" data-act="open" data-id="' + esc(x.id) + '"><div class="t">' + esc(sp.name.ja) + (x.optional ? ' <small>（寄り道）</small>' : '') + '</div>' +
        '<div class="s">滞在 約' + (x.stay_min || sp.duration_min) + '分' + (x.note ? '・' + esc(x.note) : '') + '</div></button>' +
        '<button class="check" data-act="visit" data-id="' + esc(x.id) + '" aria-pressed="' + (!!S.visited[x.id]) + '" aria-label="訪問済み">' + (S.visited[x.id] ? '✓' : '') + '</button></li>';
      var rest = kids() && (c.rests || []).filter(function (r) { return r.after === x.id; })[0];
      if (rest) html += '<li>' + restHtml(rest) + '</li>';
    });
    $('#stopList').innerHTML = html;
    renderNav();
  }

  // 交通移動の区間（stops[].leg）
  var MODE_ICON = { 'KTM': '🚆', 'LRT': '🚈', 'MRT': '🚇', 'モノレール': '🚝', 'GO KL': '🚌', 'バス': '🚌', 'Grab': '🚗', '徒歩': '🚶' };
  function legHtml(leg, inList) {
    var modes = (leg.modes || []).map(function (m) { return '<span class="mode">' + (MODE_ICON[m] || '➡️') + ' ' + esc(m) + '</span>'; }).join('');
    return (inList ? '<span class="leg-arrow">↓</span> ' : '') + '<span class="modes">' + modes + '</span>' +
      (leg.time ? ' <strong class="leg-time">' + esc(leg.time) + '</strong>' : '') +
      (leg.verified === false ? ' <span class="badge-check">要確認</span>' : '') +
      '<div class="leg-text">' + esc(leg.text || '') + (leg.note ? '<br><small>' + esc(leg.note) + '</small>' : '') + '</div>';
  }
  function kidsGuideHtml(g) {
    return '<div class="card kids-guide"><h3>🚃 ' + safeRuby(g.title) + '</h3><ol>' +
      g.steps.map(function (s) { return '<li>' + safeRuby(s) + '</li>'; }).join('') + '</ol>' +
      (g.note ? '<p class="small-text">' + safeRuby(g.note) + '</p>' : '') + '</div>';
  }

  function restHtml(r, noTitle) {
    return '<div class="rest-card">' + (noTitle ? '' : '<h4>🥤 ' + safeRuby(r.title) + '</h4>') +
      '<ul>' + r.places.map(function (p) {
        return '<li>' + esc(p.name) + ' <button class="btn small" data-act="showmap" data-lat="' + p.lat + '" data-lng="' + p.lng + '">ちずで見る</button></li>';
      }).join('') + '</ul>' +
      '<small>' + safeRuby(r.shade || '') + '<br>※お店の営業時間は要確認（OpenStreetMapの情報）。水をのんで、日かげで休もう。</small></div>';
  }

  function stampPanelHtml(c) {
    var req = c.stops.filter(function (x) { return !x.optional; });
    var got = req.filter(function (x) { return S.visited[x.id]; }).length;
    var html = '<div class="card"><strong>🏅 スタンプラリー</strong>（' + got + ' / ' + req.length + '）' +
      '<div class="stamp-grid">' + req.map(function (x) {
        var s = S.spots[x.id], n = stopNo(c, x.id);
        var short = s.name.ja.replace(/（.*?）/g, '').slice(0, 8);
        return '<button class="stamp' + (S.visited[x.id] ? ' got' : '') + '" data-stamp="' + esc(x.id) + '" data-act="open" data-id="' + esc(x.id) + '" style="cursor:pointer">' +
          '<b>' + (S.visited[x.id] ? '★' : n) + '</b>' + esc(short) + '</button>';
      }).join('') + '</div>';
    if (got === req.length && req.length) html += '<div class="btn-row"><button class="btn primary big" data-act="cert" data-id="' + esc(c.id) + '" style="flex:1">🎖 にんていしょうを見る</button></div>';
    else html += '<p class="small-text">ぜんぶあつめると「' + safeRuby(S.city.master) + '」になれるよ！</p>';
    return html + '</div>';
  }

  function toggleVisited(id) {
    if (S.visited[id]) delete S.visited[id]; else S.visited[id] = Date.now();
    csave('visited', S.visited);
    afterVisitChange(id, !!S.visited[id]);
  }
  function afterVisitChange(id, on) {
    renderAllDynamic();
    if (S.tab === 'learn') renderLearn();
    if (S.currentSheet === id) refreshSheetFoot(id);
    if (on && kids()) {
      toast('スタンプをゲット！ ★');
      var el = document.querySelector('[data-stamp="' + id + '"]'); if (el) el.classList.add('pop');
      checkMaster();
    }
  }
  function checkMaster() {
    var c = course(); if (c.transport) return;
    var req = c.stops.filter(function (x) { return !x.optional; });
    if (req.every(function (x) { return S.visited[x.id]; }) && !S.certs[c.id]) {
      S.certs[c.id] = Date.now(); csave('certs', S.certs);
      setTimeout(function () { showCert(c.id); }, 600);
    }
  }

  function nextStop() {
    var c = course(), i = curIdx(), st = c.stops[i];
    var wasVisited = !!S.visited[st.id];
    if (!wasVisited) { S.visited[st.id] = Date.now(); csave('visited', S.visited); }
    var rest = kids() && (c.rests || []).filter(function (r) { return r.after === st.id; })[0];
    if (i < c.stops.length - 1) setIdx(i + 1);
    afterVisitChange(st.id, !wasVisited);
    if (i >= c.stops.length - 1 && !kids()) toast('おつかれさまでした！コース完了です');
    if (rest) {
      openModal('<h2>🥤 ' + safeRuby(rest.title) + '</h2><p>2〜3か所まわったら、ひと休み。水をのんで、すずしいところで休もう！</p>' + restHtml(rest, true) +
        '<div class="btn-row"><button class="btn primary big" data-act="closemodal" style="flex:1">休けいおわり！つぎへ</button></div>');
    }
  }

  // ---------- スポット詳細 ----------
  // 文ごとに <span class="sent"> で囲み、読み上げのハイライトに使う
  function sentHtml(text, isRuby, list) {
    return splitSentences(text).map(function (t) {
      var i = list.length; list.push(speechText(t));
      return '<span class="sent" data-si="' + i + '">' + (isRuby ? safeRuby(t) : esc(t)) + '</span>';
    }).join('');
  }

  function openSpot(id) {
    var s = S.spots[id]; if (!s) return;
    stopAudio();
    S.currentSheet = id;
    var c = course(), n = stopNo(c, id);
    var st = c.stops.filter(function (x) { return x.id === id; })[0];
    $('#sheetNum').textContent = n ? (c.short || c.id) + ' の ' + n + ' 番目' : 'コース外のスポット';
    var showKids = kids() && !S.forceAdultDetail;
    var list = [];
    var title = '<h2 id="sheetTitle"><span class="sent" data-si="0">' + esc(s.name.ja) + '</span></h2>';
    list.push(s.name.ja + '。');
    var body = showKids ? kidsDetail(s, list) : adultDetail(s, st, list);
    $('#sheetBody').innerHTML = heroHtml(s, n) + '<div class="detail">' + title +
      '<div class="names">' + esc(s.name.en) + (s.name.local && s.name.local !== s.name.en ? '／' + esc(s.name.local) : '') + '</div>' +
      eraChips(s) + body + '</div>';
    $('#sheetBody').scrollTop = 0;
    S.audio.sents = list; S.audio.i = 0;
    renderAudioBar();
    refreshSheetFoot(id);
    $('#sheet').hidden = false;
  }
  function refreshSheetFoot(id) {
    var s = S.spots[id], visited = !!S.visited[id];
    $('#sheetFoot').innerHTML =
      '<button class="btn" data-act="showmap" data-lat="' + s.lat + '" data-lng="' + s.lng + '">' + (kids() ? 'ちず' : '地図') + '</button>' +
      '<button class="btn ' + (visited ? '' : 'primary') + '" data-act="visit" data-id="' + esc(id) + '" style="flex:2">' +
      (visited ? (kids() ? '★ スタンプずみ' : '✓ 訪問済み（取消）') : (kids() ? 'スタンプをおす' : '訪問済みにする')) + '</button>';
  }

  function eraChips(s) {
    if (!S.timeline || !s.eras || !s.eras.length) return '';
    return '<div class="era-chips">' + s.eras.map(function (id) {
      var e = eraById(id); if (!e) return '';
      return '<button class="era-chip" data-act="era" data-id="' + esc(id) + '" style="--era:' + esc(e.color) + '">📜 ' + (kids() ? safeRuby(e.kids_title.replace(/^[^：]*：/, '')) : esc(e.title) + '<small>' + esc(e.period) + '</small>') + '</button>';
    }).join('') + '</div>';
  }

  function heroHtml(s, n) {
    if (s.photo && s.photo.src) {
      return '<div class="hero"><img src="' + esc(s.photo.src) + '" alt="' + esc(s.name.ja) + 'の写真" decoding="async">' +
        '<div class="credit">写真: ' + esc(s.photo.credit) + ' / <a href="' + esc(s.photo.license_url || s.photo.source_url) + '" target="_blank" rel="noopener">' + esc(s.photo.license) + '</a>（<a href="' + esc(s.photo.source_url) + '" target="_blank" rel="noopener">Wikimedia Commons</a>）</div></div>';
    }
    return '<div class="hero"><div class="placeholder"><b>' + (n || '•') + '</b>写真は準備中です</div></div>';
  }

  function factRow(label, f) {
    if (!f) return '';
    return '<dt>' + label + '</dt><dd>' + (f.verified ? '' : '<span class="badge-check">要確認</span>') + esc(f.text) +
      (f.ref ? '<span class="ref">' + esc(f.ref) + '</span>' : '') + '</dd>';
  }

  function adultDetail(s, st, list) {
    var h = '';
    h += '<p><strong>' + esc(s.summary) + '</strong></p>';
    h += '<dl class="facts"><dt>所要時間</dt><dd>約' + s.duration_min + '分' + (st && st.stay_min && st.stay_min !== s.duration_min ? '（このコースでは約' + st.stay_min + '分）' : '') + '</dd>' +
      factRow('入場料', s.fee) + factRow('営業時間', s.hours) +
      (s.transport ? '<dt>アクセス</dt><dd>' + esc(s.transport) + '</dd>' : '') + '</dl>';
    if (st && st.note) h += '<p class="small-text">📝 ' + esc(st.note) + '</p>';
    h += '<h3>解説</h3><p class="speakable">' + sentHtml(s.description, false, list) + '</p>';
    list.push('歴史的背景。');
    h += '<h3><span class="sent" data-si="' + (list.length - 1) + '">歴史的背景</span></h3><p class="speakable">' + sentHtml(s.background, false, list) + '</p>';
    if (s.highlights && s.highlights.length) h += '<h3>見どころ</h3><ul>' + s.highlights.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    if (s.photo_spots && s.photo_spots.length) h += '<h3>写真撮影ポイント</h3><ul>' + s.photo_spots.map(function (x) { return '<li>📷 ' + esc(x) + '</li>'; }).join('') + '</ul>';
    if (s.cautions && s.cautions.length) h += '<h3>注意事項</h3><div class="caution"><ul>' + s.cautions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    if (s.murals && s.murals.length) h += '<h3>周辺の主な作品</h3>' + muralList(s, false);
    h += '<h3>出典・参考</h3><ul class="sources">' + (s.sources || []).map(function (x) { return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a></li>'; }).join('') + '</ul>';
    h += '<p class="small-text">' + (s.verified ? '<span class="badge-ok">座標・内容確認済</span>' : '<span class="badge-check">未確認</span>') + 'データ確認日: ' + esc(S.data.meta.data_checked) + '</p>';
    if (kids()) h += '<div class="btn-row"><button class="btn" data-act="adultview">こども用のおはなしにもどる</button></div>';
    return h;
  }

  function kidsDetail(s, list) {
    var h = '<div class="kids-text speakable">' + sentHtml(s.kids_text || '', true, list) + '</div>';
    if (s.kids_quiz) {
      list.push(s.kids_quiz.type === 'move' ? 'からだをうごかそう。' : 'みつけてみよう。');
      var qi = list.length;
      list.push(speechText(s.kids_quiz.question));
      h += '<div class="quiz' + (s.kids_quiz.type === 'move' ? ' move' : '') + '"><div class="q"><span class="sent" data-si="' + (qi - 1) + '">' + (s.kids_quiz.type === 'move' ? '🏃 からだをうごかそう！' : '🔍 みつけてみよう！') + '</span><br><span class="sent" data-si="' + qi + '">' + safeRuby(s.kids_quiz.question) + '</span></div>' +
        '<button class="btn" data-act="quiz" style="margin-top:10px">こたえを見る</button><div class="a" hidden>' + safeRuby(s.kids_quiz.answer) + '</div></div>';
    }
    if (s.murals && s.murals.length) {
      var found = s.murals.filter(function (m) { return S.murals[m.id]; }).length;
      h += '<h3>🎨 さがしてみよう（' + found + ' / ' + s.murals.length + '）</h3>' + muralList(s, true) +
        '<p class="small-text">かべの絵は、きえたり、ぬりかえられたりしていることもあるよ。</p>';
    }
    h += '<h3>⏱ かかる時間</h3><p>だいたい ' + s.duration_min + ' 分</p>';
    h += '<div class="btn-row"><button class="btn" data-act="adultview">おとな向けの説明を見る</button></div>';
    return h;
  }

  function muralList(s, kidsStyle) {
    return '<ul class="mural-list">' + s.murals.map(function (m) {
      var f = !!S.murals[m.id];
      return '<li><button class="check" data-act="mural" data-id="' + esc(m.id) + '" aria-pressed="' + f + '" aria-label="みつけた">' + (f ? '✓' : '') + '</button>' +
        '<div><div class="mn">' + (kidsStyle ? safeRuby(m.hint_ja) : esc(m.name)) + '</div><small>' + (kidsStyle ? esc(m.name) : esc(speechText(m.hint_ja))) + '</small></div>' +
        '<button class="btn small" data-act="showmap" data-lat="' + m.lat + '" data-lng="' + m.lng + '">' + (kidsStyle ? 'ちず' : '地図') + '</button></li>';
    }).join('') + '</ul>';
  }

  function toggleMural(id) {
    if (S.murals[id]) delete S.murals[id]; else { S.murals[id] = Date.now(); if (kids()) toast('みつけた！🎨'); }
    csave('murals', S.murals);
    // 詳細画面のチェックだけ更新（読み上げ中でも止めない）
    $all('.check[data-act="mural"][data-id="' + id + '"]').forEach(function (b) { b.setAttribute('aria-pressed', String(!!S.murals[id])); b.textContent = S.murals[id] ? '✓' : ''; });
    renderMapLayers();
  }

  function closeSheet() { stopAudio(); $('#sheet').hidden = true; S.currentSheet = null; S.forceAdultDetail = false; }

  // ---------- 音声ガイド（Web Speech API） ----------
  // 1文ずつ読み上げ、読んでいる文をハイライト。一時停止は「その文の頭から再開」方式（iOSで安定するため）
  function baseRate() { return (kids() && !S.forceAdultDetail) ? 0.85 : 1.0; }
  function jaVoice() {
    var v = ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter(function (x) { return /^ja/i.test(x.lang); }) : [];
    return v[0] || null;
  }
  function playFrom(i) {
    if (!('speechSynthesis' in window)) { toast('この端末は読み上げに対応していません'); return; }
    var A = S.audio; if (!A.sents.length) return;
    A.i = Math.max(0, Math.min(i, A.sents.length - 1));
    A.playing = true;
    var token = ++A.token;
    speechSynthesis.cancel();
    speakOne(token);
    renderAudioBar();
  }
  function speakOne(token) {
    var A = S.audio;
    if (token !== A.token || !A.playing) return;
    if (A.i >= A.sents.length) { A.playing = false; A.i = 0; highlight(-1); renderAudioBar(); return; }
    var u = new SpeechSynthesisUtterance(A.sents[A.i]);
    u.lang = 'ja-JP'; u.rate = baseRate() * S.rate; u.pitch = (kids() && !S.forceAdultDetail) ? 1.1 : 1.0;
    var v = jaVoice(); if (v) u.voice = v;
    u.onstart = function () { if (token === A.token) { highlight(A.i); renderAudioBar(); } };
    u.onend = function () { if (token !== A.token || !A.playing) return; A.i++; speakOne(token); };
    u.onerror = function (e) { if (token !== A.token) return; if (e.error === 'interrupted' || e.error === 'canceled') return; A.playing = false; renderAudioBar(); };
    highlight(A.i);
    speechSynthesis.speak(u);
  }
  function pauseAudio() {
    S.audio.playing = false; S.audio.token++;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    renderAudioBar();
  }
  function stopAudio() {
    S.audio.playing = false; S.audio.token++; S.audio.i = 0;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    highlight(-1);
    renderAudioBar();
  }
  function togglePlay() { if (S.audio.playing) pauseAudio(); else playFrom(S.audio.i); }
  function cycleRate() {
    var i = RATES.indexOf(S.rate); S.rate = RATES[(i + 1) % RATES.length]; save('rate', S.rate);
    if (S.audio.playing) playFrom(S.audio.i); else renderAudioBar();
  }
  function highlight(i) {
    $all('#sheetBody .sent.reading').forEach(function (el) { el.classList.remove('reading'); });
    if (i < 0) return;
    $all('#sheetBody .sent[data-si="' + i + '"]').forEach(function (el, k) {
      el.classList.add('reading');
      if (k === 0 && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
  function renderAudioBar() {
    var A = S.audio, bar = $('#audioBar'); if (!bar) return;
    var total = A.sents.length;
    bar.innerHTML =
      '<button class="icon-btn" data-act="aprev" aria-label="前の文">⏮</button>' +
      '<button class="btn primary audio-play" data-act="play" aria-label="' + (A.playing ? '一時停止' : '再生') + '">' + (A.playing ? '⏸ ' + (kids() ? 'とめる' : '一時停止') : '▶ ' + (kids() ? 'きく' : '音声ガイド')) + '</button>' +
      '<button class="icon-btn" data-act="anext" aria-label="次の文">⏭</button>' +
      '<button class="btn small" data-act="rate" aria-label="読み上げ速度">' + (kids() ? 'はやさ ' : '速度 ') + S.rate + 'x</button>' +
      '<span class="audio-pos">' + (total ? (Math.min(A.i + 1, total)) + '/' + total : '') + '</span>';
    var hb = $('#sheetSpeak'); if (hb) { hb.textContent = A.playing ? '⏸' : '🔊'; hb.classList.toggle('on', A.playing); }
  }

  // ---------- モーダル／認定証 ----------
  function openModal(html) { $('#modalCard').innerHTML = html; $('#modal').hidden = false; }
  function closeModal() {
    var inp = $('#kidName'); if (inp) { S.kidName = inp.value; save('kidName', S.kidName); }
    $('#modal').hidden = true;
  }
  function showCert(cid) {
    var c = S.data.courses.filter(function (x) { return x.id === cid; })[0] || course();
    var d = new Date(S.certs[c.id] || Date.now());
    openModal('<div class="cert"><div class="medal">🏅</div><div>にんていしょう</div>' +
      '<div class="big">' + safeRuby(S.city.master) + '</div>' +
      '<input id="kidName" placeholder="なまえをかいてね" value="' + esc(S.kidName) + '" aria-label="なまえ">' +
      '<p>あなたは ' + esc(S.city.place_label) + 'の ' + esc(c.name.replace(/^.：/, '')) + ' の スタンプを ぜんぶ あつめました。<br>' + esc(S.city.name) + 'の むかしの おはなしを たくさん しった、りっぱな たんけんかです！</p>' +
      '<p><small>' + d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日</small></p></div>' +
      '<div class="btn-row"><button class="btn primary big" data-act="closemodal" style="flex:1">やったね！</button></div>');
  }

  // ---------- 年表・用語集 ----------
  function renderLearn() {
    if (!S.data) return;
    var hasTl = !!S.timeline;
    if (!hasTl) S.learnTab = 'glossary';
    $('#learnTabs').innerHTML = (hasTl ? '<button class="chip" role="tab" aria-selected="' + (S.learnTab === 'timeline') + '" data-act="learn" data-id="timeline">' + (kids() ? 'むかしのおはなし' : '年表') + '</button>' : '') +
      '<button class="chip" role="tab" aria-selected="' + (S.learnTab === 'glossary') + '" data-act="learn" data-id="glossary">' + (kids() ? 'ことば' : '用語集') + '</button>';
    $('#timelineBox').hidden = S.learnTab !== 'timeline';
    $('#glossaryBox').hidden = S.learnTab !== 'glossary';
    if (hasTl && S.learnTab === 'timeline') renderTimeline();
  }
  function spotBtn(id) {
    var s = S.spots[id]; if (!s) return '';
    return '<button class="spot-link' + (S.visited[id] ? ' visited' : '') + '" data-act="open" data-id="' + esc(id) + '">' + (S.visited[id] ? '✓ ' : '') + esc(s.name.ja.replace(/（.*?）/g, '')) + '</button>';
  }
  // マレーシア全体の流れ（timeline.json の national）。city は都市idの配列（空＝全体）
  function nationalHtml(N) {
    var names = {}; S.cities.forEach(function (c) { names[c.id] = c.name; });
    var evs = N.events.filter(function (e) { return !kids() || e.kids; });
    return '<section class="national"><h2 class="section-h">🇲🇾 ' + (kids() ? 'マレーシアの<ruby>歴史<rt>れきし</rt></ruby>と3つの<ruby>町<rt>まち</rt></ruby>' : esc(N.title)) + '</h2>' +
      '<p class="' + (kids() ? 'kids-text' : 'era-sum') + '">' + (kids() ? safeRuby(N.kids_intro) : esc(N.intro)) + '</p><ol class="events">' +
      evs.map(function (e) {
        var here = (e.city || []).indexOf(S.cityId) >= 0;
        var tags = (e.city && e.city.length ? e.city : ['all']).map(function (id) {
          return '<span class="city-tag' + (id === S.cityId ? ' here' : '') + '">' + esc(id === 'all' ? 'マレーシア全体' : (names[id] || id)) + '</span>';
        }).join('');
        return '<li class="' + (here ? 'is-here' : '') + '"><span class="ev-year">' + esc(e.year) + '</span><div>' + tags + '<br>' +
          (kids() ? safeRuby(e.kids) : '<span class="ev-text">' + esc(e.text) + '</span>') + '</div></li>';
      }).join('') + '</ol></section>';
  }
  function renderTimeline() {
    var T = S.timeline, h = '';
    if (kids()) {
      h += '<h2 class="section-h">📖 ' + safeRuby(T.kids_title) + '</h2><p class="kids-text">' + safeRuby(T.kids_intro) + '</p>';
      T.eras.forEach(function (e, i) {
        var spots = S.data.spots.filter(function (s) { return (s.eras || []).indexOf(e.id) >= 0; });
        h += '<section class="story" id="era-' + esc(e.id) + '" style="--era:' + esc(e.color) + '">' +
          '<div class="story-no">' + (i + 1) + '</div><h3>' + safeRuby(e.kids_title) + '</h3>' +
          '<p class="story-year">' + esc(e.period) + '</p><p>' + safeRuby(e.kids_text) + '</p>' +
          (spots.length ? '<div class="spot-links"><small>この{時代|じだい}のスポット：</small>'.replace('{時代|じだい}', '<ruby>時代<rt>じだい</rt></ruby>') + spots.map(function (s) { return spotBtn(s.id); }).join('') + '</div>' : '') +
          '</section>';
      });
    } else {
      h += '<h2 class="section-h">' + esc(T.title) + '</h2>';
      T.eras.forEach(function (e) {
        var evs = T.events.filter(function (ev) { return ev.era === e.id; });
        h += '<section class="era" id="era-' + esc(e.id) + '" style="--era:' + esc(e.color) + '">' +
          '<h3>' + esc(e.title) + ' <small>' + esc(e.period) + '</small></h3><p class="era-sum">' + esc(e.summary) + '</p><ol class="events">' +
          evs.map(function (ev) {
            return '<li><span class="ev-year">' + esc(ev.year) + '</span><div><strong>' + esc(ev.title) + '</strong><br><span class="ev-text">' + esc(ev.text) + '</span>' +
              (ev.spots && ev.spots.length ? '<div class="spot-links">' + ev.spots.map(spotBtn).join('') + '</div>' : '') + '</div></li>';
          }).join('') + '</ol></section>';
      });
    }
    if (T.national) h += nationalHtml(T.national);
    $('#timelineBox').innerHTML = h;
  }

  function renderGlossary() {
    var q = ($('#glossarySearch').value || '').trim().toLowerCase();
    $('#glossaryList').innerHTML = S.glossary.filter(function (t) {
      return !q || (t.term + t.en + t.text).toLowerCase().indexOf(q) >= 0;
    }).map(function (t) {
      return '<dt>' + esc(t.term) + '<small>' + esc(t.en) + '</small></dt><dd>' + esc(t.text) + '</dd>';
    }).join('') || '<p>見つかりませんでした</p>';
  }

  function renderInfo() {
    $('#infoSections').innerHTML = '<h2 class="section-h">実用情報（' + esc(S.city.name) + '）</h2>' + S.info.map(function (sec) {
      var h = '<div class="card info-sec" id="info-' + esc(sec.id) + '"><h3>' + esc(sec.icon || '') + ' ' + esc(sec.title) + '</h3>';
      if (sec.contacts) h += sec.contacts.map(function (c) {
        return '<div class="tel"><span>' + esc(c.label) + (c.verified ? '' : ' <span class="badge-check">要確認</span>') + '</span><a href="tel:' + esc(c.number.replace(/[^\d+]/g, '')) + '">' + esc(c.number) + '</a></div>';
      }).join('');
      if (sec.items) h += '<ul>' + sec.items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>';
      return h + '</div>';
    }).join('');
  }

  function renderAbout() {
    var unver = [];
    S.data.spots.forEach(function (s) {
      var f = [];
      if (s.fee && !s.fee.verified) f.push('入場料');
      if (s.hours && !s.hours.verified) f.push('営業時間');
      if (f.length) unver.push('<li>' + esc(s.name.ja) + '：' + f.join('・') + '</li>');
    });
    $('#aboutBox').innerHTML =
      '<p>' + esc(S.city.name) + 'のデータ確認日：' + esc(S.data.meta.data_checked) + '。座標はOpenStreetMapで確認しています。入場料・営業時間は変わりやすいので、「要確認」の表示があるものは現地や公式サイトで確認してください。</p>' +
      '<p>地図データ © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>（ODbL）。徒歩ルートはOpenStreetMapのデータを使った経路探索（FOSSGIS routing）で作成。写真はWikimedia Commonsの自由ライセンス画像で、作者とライセンスを各スポットに記載しています。</p>' +
      '<details><summary><strong>要確認の情報一覧（' + unver.length + '件）</strong></summary><ul>' + unver.join('') + '</ul></details>' +
      '<p>このアプリは個人の旅行用に作成したもので、内容の正確性を保証するものではありません。</p>';
  }

  // ---------- オフライン地図（タイルの事前取得） ----------
  function lng2x(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
  function lat2y(lat, z) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
  function tileList() {
    var list = [], seen = {};
    ((S.city && S.city.tile_areas) || []).forEach(function (a) {
      a.zooms.forEach(function (z) {
        var x0 = lng2x(a.bbox[1], z), x1 = lng2x(a.bbox[3], z), y0 = lat2y(a.bbox[2], z), y1 = lat2y(a.bbox[0], z);
        for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
          var k = z + '/' + x + '/' + y; if (seen[k]) continue; seen[k] = 1;
          list.push(TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        }
      });
    });
    return list.slice(0, TILE_LIMIT);
  }
  function updateTileInfo() {
    if (!('caches' in window)) { $('#tileInfo').textContent = 'この環境ではオフライン保存を使えません。'; $('#btnTiles').disabled = true; return; }
    var list = tileList();
    caches.open(TILE_CACHE).then(function (c) { return Promise.all(list.map(function (u) { return c.match(u); })); }).then(function (hits) {
      var have = hits.filter(Boolean).length;
      $('#tileInfo').textContent = S.city.name + 'のツアー範囲の地図（ズーム14〜17。郊外はスポット周辺のみ。全' + list.length + '枚）を端末に保存します。保存済み：' + have + '枚。Wi-Fi接続時がおすすめです。';
    });
  }
  function downloadTiles() {
    if (!('caches' in window)) return;
    if (!navigator.onLine) { toast('オフラインです。ネットにつながっている時に保存してください'); return; }
    var list = tileList(), done = 0, fail = 0, i = 0;
    var btn = $('#btnTiles'), prog = $('#tileProgress'), bar = prog.querySelector('.bar');
    btn.disabled = true; prog.hidden = false;
    caches.open(TILE_CACHE).then(function (cache) {
      function worker() {
        if (i >= list.length) return Promise.resolve();
        var url = list[i++];
        return cache.match(url).then(function (hit) {
          if (hit) return;
          return fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (r) {
            if (!r.ok) throw new Error(r.status);
            return cache.put(url, r);
          });
        }).catch(function () { fail++; }).then(function () {
          done++; bar.style.width = (done / list.length * 100).toFixed(0) + '%';
          return new Promise(function (res) { setTimeout(res, 60); }); // サーバー負荷に配慮して少し間隔をあける
        }).then(worker);
      }
      return Promise.all([worker(), worker()]); // 同時接続は2本まで
    }).then(function () {
      btn.disabled = false; prog.hidden = true; updateTileInfo();
      toast(fail ? '保存完了（' + fail + '枚失敗。もう一度押すと失敗分だけ再取得します）' : S.city.name + 'の地図を保存しました。オフラインでも表示できます', 4000);
    });
  }
  function clearTiles() {
    if (!('caches' in window)) return;
    var list = tileList();
    caches.open(TILE_CACHE).then(function (c) { return Promise.all(list.map(function (u) { return c.delete(u); })); })
      .then(function () { updateTileInfo(); toast(S.city.name + 'の保存した地図を削除しました'); });
  }

  init();
})();
