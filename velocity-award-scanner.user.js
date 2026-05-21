// ==UserScript==
// @name         Velocity Award Scanner
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Scans Virgin Australia Velocity reward flights across date ranges and multiple routes
// @author       rickyg
// @match        https://book.virginaustralia.com/dx/VADX/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      book.virginaustralia.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const API_URL = 'https://book.virginaustralia.com/api/graphql';
  const DELAY_MS = 950;

  // ─── SNIFF x-sabre-storefront FROM PAGE'S OWN REQUESTS ─────────────────────
  // Inject into the page's real JS context (Tampermonkey runs in an isolated sandbox)
  ;(function injectInterceptor() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        function storeVal(val) {
          if (val) document.documentElement.setAttribute('data-va-storefront', val);
        }
        var _fetch = window.fetch;
        window.fetch = function(input, init) {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.indexOf('/api/graphql') !== -1 && init && init.headers) {
            var h = init.headers;
            storeVal(h instanceof Headers ? h.get('x-sabre-storefront') : (h['x-sabre-storefront'] || h['X-Sabre-Storefront']));
          }
          return _fetch.apply(this, arguments);
        };
        var _xhr = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
          if (name && name.toLowerCase() === 'x-sabre-storefront') storeVal(value);
          return _xhr.call(this, name, value);
        };
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  })();

  function getCapturedStorefront() {
    // DOM attribute is written by the injected page-context script (shared across sandbox boundary)
    return document.documentElement.getAttribute('data-va-storefront') || 'VADX';
  }
  const BATCH_DAYS = 20;

  const BRANDS = {
    RB: { label: 'RB', name: 'Business Reward', color: '#6c2fa0' },
    BU: { label: 'BU', name: 'Business',        color: '#002e6c' },
    RP: { label: 'RP', name: 'Premium Reward',  color: '#487c93' },
    RE: { label: 'RE', name: 'Economy Reward',  color: '#016564' },
    RF: { label: 'RF', name: 'First Reward',    color: '#832c40' },
  };

  // ─── STATE ──────────────────────────────────────────────────────────────────
  let scanning = false;
  let stopRequested = false;
  let currentDateIndex = 0;
  let scanDates = [];
  let scanRoutes = [];
  let totalRequests = 0;
  let completedRequests = 0;
  let activeTab = null;
  let autoScroll = true;

  // ─── SHADOW DOM CONTAINER ───────────────────────────────────────────────────
  const host = document.createElement('div');
  host.id = 'va-scanner-host';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    #root {
      position: fixed; bottom: 0; right: 0; z-index: 2147483647;
      width: 520px; max-height: 92vh;
      display: flex; flex-direction: column;
      background: #120808; color: #e8e0e0;
      font-family: system-ui, -apple-system, sans-serif; font-size: 13px;
      border-radius: 12px 12px 0 0;
      box-shadow: -2px -2px 24px rgba(0,0,0,0.7);
      border-top: 2px solid #c0392b;
      border-left: 1px solid #3a1a1a;
      border-right: 1px solid #3a1a1a;
      transition: transform 0.25s ease;
    }
    #root.collapsed { transform: translateY(calc(100% - 42px)); }

    /* ── header ── */
    #header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px; cursor: pointer; user-select: none;
      border-bottom: 1px solid #2a1010;
      flex-shrink: 0;
    }
    #header .logo { color: #c0392b; font-size: 17px; }
    #header .title { font-weight: 700; font-size: 14px; flex: 1; color: #f0e0e0; }
    #header .chevron { color: #888; font-size: 16px; transition: transform 0.2s; }
    #root.collapsed #header .chevron { transform: rotate(180deg); }

    /* ── form ── */
    #form-area {
      padding: 12px 14px 10px;
      border-bottom: 1px solid #2a1010;
      flex-shrink: 0;
    }
    .row { display: flex; gap: 8px; margin-bottom: 8px; align-items: flex-end; }
    .field { display: flex; flex-direction: column; flex: 1; }
    .field label { font-size: 11px; color: #888; margin-bottom: 3px; }
    input, select {
      background: #0d0505; border: 1px solid #3a1a1a; border-radius: 6px;
      color: #e8e0e0; padding: 5px 8px; font-size: 12px; width: 100%;
      outline: none;
    }
    input:focus, select:focus { border-color: #c0392b; }
    .swap-btn {
      background: #1e0c0c; border: 1px solid #3a1a1a; border-radius: 6px;
      color: #c0392b; cursor: pointer; font-size: 15px;
      padding: 5px 9px; align-self: flex-end; flex-shrink: 0;
    }
    .swap-btn:hover { background: #2a1010; }

    /* ── brand filters ── */
    #filters {
      display: flex; flex-wrap: wrap; gap: 6px;
      padding: 8px 14px; border-bottom: 1px solid #2a1010;
      flex-shrink: 0;
    }
    .filter-chip {
      display: flex; align-items: center; gap: 4px;
      padding: 3px 8px; border-radius: 4px; cursor: pointer;
      font-size: 11px; font-weight: 600; user-select: none;
      border: 1.5px solid #2a1a1a; transition: all 0.15s;
      background: #1a0a0a; color: #444;
    }
    .filter-chip.on { color: #fff; border-color: rgba(255,255,255,0.2); }
    .filter-chip:not(.on) .chip-name { text-decoration: line-through; }
    .filter-chip input { display: none; }

    /* ── tab bar ── */
    #tab-bar {
      display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 5px;
      padding: 6px 10px; border-bottom: 1px solid #2a1010; flex-shrink: 0;
      scrollbar-width: none;
    }
    #tab-bar:empty { display: none; }
    #tab-bar::-webkit-scrollbar { display: none; }
    .tab {
      background: #1a0a0a; border: 1px solid #2a1010; border-radius: 5px;
      color: #666; cursor: pointer; font-size: 11px; font-weight: 600;
      padding: 4px 10px; white-space: nowrap; flex-shrink: 0; transition: all 0.15s;
    }
    .tab:hover { color: #e8e0e0; border-color: #3a1a1a; }
    .tab.active { background: #c0392b; border-color: #c0392b; color: #fff; }
    .tab-count {
      background: rgba(0,0,0,0.3); border-radius: 3px;
      padding: 0 4px; margin-left: 4px; font-size: 10px;
    }

    /* ── footer bar ── */
    #footer {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid #2a1010;
      flex-shrink: 0;
    }
    .btn {
      border: none; border-radius: 6px; cursor: pointer;
      font-size: 12px; font-weight: 600; padding: 7px 16px; color: #fff;
      transition: opacity 0.15s;
    }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .btn-scan  { background: #c0392b; flex: 1; }
    .btn-stop  { background: #5a2020; }
    .btn-clear { background: #2a1a1a; }
    #status-text { font-size: 11px; color: #888; flex: 1; text-align: right; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

    /* ── progress bar ── */
    #progress-wrap { height: 3px; background: #1e0c0c; flex-shrink: 0; }
    #progress-bar  { height: 3px; background: #c0392b; width: 0; transition: width 0.3s; }

    /* ── results ── */
    #results {
      overflow-y: auto; flex: 1; padding: 8px 10px;
      min-height: 0;
    }
    .empty-msg { color: #555; text-align: center; padding: 24px 0; font-size: 12px; }
    #scan-banner {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: #888; padding: 4px 2px 8px;
    }
    #scan-banner .spinner {
      display: inline-block; width: 10px; height: 10px;
      border: 2px solid #3a1a1a; border-top-color: #c0392b;
      border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .date-block { margin-bottom: 10px; }
    .date-header {
      font-size: 11px; font-weight: 700; color: #c0392b;
      padding: 4px 6px; letter-spacing: 0.05em; text-transform: uppercase;
      border-bottom: 1px solid #2a1010; margin-bottom: 6px;
    }
    .route-row {
      display: flex; flex-wrap: wrap; gap: 5px;
      align-items: center; padding: 2px 0 6px 4px;
    }
    .route-label { display: none; }
    .pills { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; }

    .pill {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 7px; border-radius: 5px; cursor: pointer;
      font-size: 11px; font-weight: 600; color: #fff;
      position: relative; transition: opacity 0.15s;
      border: 1px solid rgba(255,255,255,0.15);
    }
    .pill:hover { opacity: 0.85; }
    .pill.nonstop { box-shadow: 0 0 0 2px #4caf50; }
    .pill .badge {
      font-size: 9px; font-weight: 700; background: rgba(0,0,0,0.3);
      padding: 1px 4px; border-radius: 3px;
    }
    .pill .seats { font-size: 9px; opacity: 0.8; }

    /* ── popup ── */
    .popup-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.6); display: flex;
      align-items: center; justify-content: center;
    }
    .popup {
      background: #1a0808; border: 1px solid #3a1a1a; border-radius: 10px;
      padding: 16px 18px; min-width: 280px; max-width: 360px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.8);
    }
    .popup h3 { font-size: 13px; color: #f0e0e0; margin-bottom: 10px; }
    .popup .row2 { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px; }
    .popup .row2 .lbl { color: #888; }
    .popup .row2 .val { color: #e8e0e0; font-weight: 600; }
    .popup .seg { margin-top: 8px; padding: 8px; background: #120606; border-radius: 6px; }
    .popup .seg .seg-row { font-size: 11px; color: #aaa; margin-bottom: 3px; }
    .popup .seg .seg-row strong { color: #e0d0d0; }
    .popup-book {
      display: block; margin-top: 12px; width: 100%; background: #c0392b;
      border-radius: 6px; color: #fff; padding: 8px; font-size: 12px; font-weight: 600;
      text-align: center; text-decoration: none;
    }
    .popup-book:hover { background: #a93226; }
    .popup-close {
      display: block; margin-top: 6px; width: 100%; background: #2a1010; border: none;
      border-radius: 6px; color: #e8e0e0; padding: 7px; cursor: pointer; font-size: 12px;
    }
    .popup-close:hover { background: #3a1a1a; }

    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #3a1a1a; border-radius: 3px; }
  `;
  shadow.appendChild(styleEl);

  // ─── ROOT ELEMENT ────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.id = 'root';
  shadow.appendChild(root);

  // ─── BUILD UI ────────────────────────────────────────────────────────────────
  function g(id) { return shadow.getElementById(id); }
  function load(key, def) { try { return GM_getValue(key, def); } catch { return def; } }
  function save(key, val) { try { GM_setValue(key, val); } catch {} }

  const today = new Date();
  const threeMonths = new Date(today); threeMonths.setMonth(threeMonths.getMonth() + 3);

  root.innerHTML = `
    <div id="header">
      <span class="logo">✈</span>
      <span class="title">Velocity Award Scanner</span>
      <span class="chevron">▲</span>
    </div>

    <div id="form-area">
      <div class="row">
        <div class="field">
          <label>Origins (comma-separated)</label>
          <input id="inp-from" type="text" placeholder="SYD,MEL" value="${load('va_from','SYD')}" style="text-transform:uppercase"/>
        </div>
        <button class="swap-btn" id="btn-swap" title="Swap">⇄</button>
        <div class="field">
          <label>Destinations (comma-separated)</label>
          <input id="inp-to" type="text" placeholder="HND,NRT" value="${load('va_to','HND')}" style="text-transform:uppercase"/>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>From date</label>
          <input id="inp-date-from" type="text" placeholder="YYYY-MM-DD" value="${load('va_date_from', fmt(today))}"/>
        </div>
        <div class="field">
          <label>To date</label>
          <input id="inp-date-to" type="text" placeholder="YYYY-MM-DD" value="${load('va_date_to', fmt(threeMonths))}"/>
        </div>
        <div class="field">
          <label>Promo (optional)</label>
          <input id="inp-promo" type="text" placeholder="e.g. CVX35" value="${load('va_promo','')}"/>
        </div>
      </div>
    </div>

    <div id="filters">
      ${Object.entries(BRANDS).map(([id, b]) => `
        <label class="filter-chip on" id="chip-${id}" style="background:${b.color};" data-brand="${id}">
          <input type="checkbox" checked data-brand="${id}"/>
          <span>${b.label}</span>
          <span class="chip-name" style="font-weight:400;opacity:0.8">${b.name}</span>
        </label>
      `).join('')}
    </div>

    <div id="progress-wrap"><div id="progress-bar"></div></div>

    <div id="tab-bar"></div>

    <div id="results"><div class="empty-msg">Enter routes and dates, then press Scan.</div></div>

    <div id="footer">
      <button class="btn btn-scan" id="btn-scan">Scan</button>
      <button class="btn btn-stop" id="btn-stop" disabled>Stop</button>
      <button class="btn btn-clear" id="btn-clear">Clear</button>
      <span id="status-text"></span>
    </div>
  `;

  // ─── EVENTS ──────────────────────────────────────────────────────────────────
  g('header').addEventListener('click', () => root.classList.toggle('collapsed'));

  g('btn-swap').addEventListener('click', () => {
    const a = g('inp-from').value, b = g('inp-to').value;
    g('inp-from').value = b; g('inp-to').value = a;
  });

  ['inp-from','inp-to'].forEach(id =>
    g(id).addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); })
  );

  ['inp-from','inp-to','inp-date-from','inp-date-to','inp-promo'].forEach(id => {
    const keyMap = { 'inp-from':'va_from','inp-to':'va_to','inp-date-from':'va_date_from','inp-date-to':'va_date_to','inp-promo':'va_promo' };
    g(id).addEventListener('change', e => save(keyMap[id], e.target.value));
  });

  // brand filter chips
  const enabledBrands = new Set(Object.keys(BRANDS));
  g('filters').addEventListener('click', e => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    const brand = chip.dataset.brand;
    const cb = chip.querySelector('input[type=checkbox]');
    cb.checked = !cb.checked;
    chip.classList.toggle('on', cb.checked);
    chip.style.background = cb.checked ? BRANDS[brand].color : '#1a0a0a';
    if (cb.checked) enabledBrands.add(brand); else enabledBrands.delete(brand);
    applyFilters();
  });

  g('btn-scan').addEventListener('click', startScan);
  g('btn-stop').addEventListener('click', () => { stopRequested = true; setStatus('Stopping…'); });
  g('btn-clear').addEventListener('click', clearAll);

  // Disable auto-scroll when user scrolls up; re-enable when back at bottom
  g('results').addEventListener('scroll', () => {
    const el = g('results');
    autoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  });

  // ─── TABS ────────────────────────────────────────────────────────────────────
  function ensureTab(routeKey) {
    if (shadow.querySelector(`.tab[data-route="${CSS.escape(routeKey)}"]`)) return;
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.route = routeKey;
    btn.innerHTML = `${routeKey} <span class="tab-count">0</span>`;
    btn.addEventListener('click', () => switchTab(routeKey));
    g('tab-bar').appendChild(btn);
    if (!activeTab) switchTab(routeKey);
  }

  function updateTabCount(routeKey) {
    const count = Object.values(resultStore).filter(d => d[routeKey]?.length > 0).length;
    const btn = shadow.querySelector(`.tab[data-route="${CSS.escape(routeKey)}"]`);
    if (btn) btn.querySelector('.tab-count').textContent = count;
  }

  function switchTab(routeKey) {
    activeTab = routeKey;
    shadow.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.route === routeKey));
    renderActiveTab();
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────
  function fmt(d) { return d.toISOString().split('T')[0]; }
  function fmtTime(iso) { return iso ? iso.slice(11, 16) : ''; }
  function fmtPts(n) { return n >= 1000 ? Math.round(n / 100) / 10 + 'k' : String(n); }
  function fmtDuration(depIso, arrIso) {
    if (!depIso || !arrIso) return '';
    const mins = Math.round((new Date(arrIso) - new Date(depIso)) / 60000);
    return `${Math.floor(mins/60)}h ${mins%60}m`;
  }

  function setStatus(msg, color) {
    const el = g('status-text');
    if (el) { el.textContent = msg; el.style.color = color || '#888'; }
  }
  function setProgress(pct) {
    const bar = g('progress-bar');
    if (bar) bar.style.width = pct + '%';
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function buildBookingUrl(origin, dest, date, promo) {
    const [y, m, d] = date.split('-');
    const dateFmt = `${m}-${d}-${y}`;
    const storefront = getCapturedStorefront();
    const params = new URLSearchParams({
      ADT: '1', CHD: '0', INF: '0',
      class: 'First',
      awardBooking: 'true',
      journeyType: 'one-way',
      date: dateFmt,
      activeMonth: dateFmt,
      origin, destination: dest,
      searchType: 'BRANDED',
      direction: '0',
      fareType: 'FIXED_REWARD',
      tpid: 'NA', cabinType: 'NA',
      businessTravel: 'false',
      showPromoCode: promo ? '1' : '0',
    });
    if (promo) params.set('promoCode', promo);
    return `https://book.virginaustralia.com/dx/${storefront}/#/flight-selection?${params.toString()}`;
  }

  function getRoutes() {
    const origins = g('inp-from').value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const dests   = g('inp-to').value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const routes = [];
    for (const o of origins) for (const d of dests) routes.push({ origin: o, dest: d });
    return routes;
  }

  function getDates(fromVal, toVal) {
    const dates = [];
    const end = new Date(toVal + 'T00:00:00');
    for (let d = new Date(fromVal + 'T00:00:00'); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(fmt(new Date(d)));
    }
    return dates;
  }

  // ─── API ────────────────────────────────────────────────────────────────────
  function searchFlight(origin, dest, date, promoCode) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        operationName: 'bookingAirSearch',
        variables: {
          airSearchInput: {
            cabinClass: 'First',
            awardBooking: true,
            promoCodes: promoCode ? [promoCode] : [],
            searchType: 'BRANDED',
            itineraryParts: [{
              from: { useNearbyLocations: false, code: origin },
              to:   { useNearbyLocations: false, code: dest },
              when: { date }
            }],
            passengers: { ADT: 1 }
          }
        },
        extensions: {},
        query: `query bookingAirSearch($airSearchInput: CustomAirSearchInput) {
  bookingAirSearch(airSearchInput: $airSearchInput) {
    originalResponse
    __typename
  }
}`
      });

      GM_xmlhttpRequest({
        method: 'POST',
        url: API_URL,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://book.virginaustralia.com',
          'Referer': 'https://book.virginaustralia.com/',
          ...(getCapturedStorefront() ? { 'x-sabre-storefront': getCapturedStorefront() } : {}),
        },
        data: body,
        onload: res => {
          try {
              const parsed = JSON.parse(res.responseText);
            resolve(parsed);
          }
          catch (e) { reject(new Error('JSON parse error: ' + res.responseText.slice(0, 200))); }
        },
        onerror: () => reject(new Error('Network error'))
      });
    });
  }

  // ─── RESPONSE PARSER ────────────────────────────────────────────────────────
  // Build a @ref→segment map by walking an object tree
  function buildRefMap(obj, map = {}) {
    if (!obj || typeof obj !== 'object') return map;
    if (Array.isArray(obj)) { obj.forEach(v => buildRefMap(v, map)); return map; }
    if (obj['@id']) map[obj['@id']] = obj;
    Object.values(obj).forEach(v => buildRefMap(v, map));
    return map;
  }

  function resolveSegment(seg, refMap) {
    if (seg && seg['@ref']) return refMap[seg['@ref']] ?? seg;
    return seg;
  }

  function parseApiResponse(apiResponse) {
    let original = apiResponse?.data?.bookingAirSearch?.originalResponse;
    if (typeof original === 'string') {
      try { original = JSON.parse(original); } catch { return []; }
    }
    if (!original || typeof original !== 'object') return [];

    const refMap = buildRefMap(original);
    const offers = original.unbundledOffers?.[0];
    if (!Array.isArray(offers)) return [];

    const flights = [];

    for (const offer of offers) {
      if (offer.soldout) continue;
      const seats = offer.seatsRemaining?.count ?? 0;
      if (seats <= 0) continue;
      if (!BRANDS[offer.brandId]) continue;

      const rawSegs = offer.itineraryPart?.[0]?.segments ?? [];
      const segments = rawSegs.map(s => resolveSegment(s, refMap)).filter(Boolean);

      const fares = offer.fare?.alternatives ?? [];
      const ptsFare = fares.flat().find(a => a.currency === 'FFCURRENCY');
      const taxFares = offer.taxes?.alternatives ?? [];
      const audTax = taxFares.flat().find(a => a.currency === 'AUD');

      flights.push({
        brandId: offer.brandId,
        cabinClass: offer.cabinClass,
        seats,
        points: ptsFare?.amount,
        taxAud: audTax?.amount,
        nonstop: segments.length === 1,
        segments: segments.map(s => ({
          flightNum: s.flight ? `${s.flight.airlineCode}${s.flight.flightNumber}` : '',
          operatingAirline: s.flight?.operatingAirlineCode ?? '',
          origin: s.origin ?? '',
          dest: s.destination ?? '',
          departure: s.departure ?? '',
          arrival: s.arrival ?? '',
          cabinClass: s.cabinClass ?? '',
          bookingClass: s.bookingClass ?? '',
        })),
      });
    }

    return flights;
  }

  // ─── RESULTS TABLE ───────────────────────────────────────────────────────────
  // { date → { routeKey → [flight, ...] } }
  const resultStore = {};

  function storeResults(date, routeKey, flights) {
    if (!resultStore[date]) resultStore[date] = {};
    if (!resultStore[date][routeKey]) resultStore[date][routeKey] = [];
    resultStore[date][routeKey].push(...flights);
  }

  function renderActiveTab() {
    const container = g('results');
    if (!container || !activeTab) return;

    const banner = container.querySelector('#scan-banner');
    container.innerHTML = '';
    if (banner) container.appendChild(banner);

    const allDates = Object.keys(resultStore).sort();
    for (const date of allDates) {
      const flights = resultStore[date]?.[activeTab] ?? [];
      const visible = flights.filter(f => enabledBrands.has(f.brandId));
      if (visible.length === 0) continue;
      container.appendChild(buildDateBlock(date, activeTab, flights));
    }

    if (!container.querySelector('.date-block') && !banner) {
      container.innerHTML = '<div class="empty-msg">No results for this route.</div>';
    }
  }

  function addResultsIncremental(date, routeKey, flights) {
    storeResults(date, routeKey, flights);
    ensureTab(routeKey);
    updateTabCount(routeKey);

    // Only update the DOM if this route is currently visible
    if (routeKey !== activeTab) return;

    const container = g('results');
    if (!container) return;

    const msg = container.querySelector('.empty-msg');
    if (msg) msg.remove();

    let block = container.querySelector(`.date-block[data-date="${date}"]`);
    if (!block) {
      block = buildDateBlock(date, routeKey, resultStore[date][routeKey]);
      const existing = Array.from(container.querySelectorAll('.date-block'));
      const after = existing.find(el => el.dataset.date > date);
      if (after) container.insertBefore(block, after);
      else container.appendChild(block);
    } else {
      const existingRow = block.querySelector('.route-row');
      if (existingRow) existingRow.remove();
      block.appendChild(buildRouteRow(routeKey, resultStore[date][routeKey], date));
    }

    if (autoScroll) container.scrollTop = container.scrollHeight;
  }

  function buildDateBlock(date, routeKey, flights) {
    const block = document.createElement('div');
    block.className = 'date-block';
    block.dataset.date = date;
    const header = document.createElement('div');
    header.className = 'date-header';
    header.textContent = formatDateHeader(date);
    block.appendChild(header);
    block.appendChild(buildRouteRow(routeKey, flights, date));
    return block;
  }

  function formatDateHeader(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function buildRouteRow(routeKey, flights, date) {
    const row = document.createElement('div');
    row.className = 'route-row';
    row.dataset.route = routeKey;

    const label = document.createElement('div');
    label.className = 'route-label';
    label.textContent = routeKey;
    row.appendChild(label);

    const pillsWrap = document.createElement('div');
    pillsWrap.className = 'pills';

    for (const flight of flights) {
      if (!enabledBrands.has(flight.brandId)) continue;
      pillsWrap.appendChild(buildPill(flight, routeKey, date));
    }

    row.appendChild(pillsWrap);
    return row;
  }

  function buildPill(flight, routeKey, date) {
    const brand = BRANDS[flight.brandId];
    const pill = document.createElement('div');
    pill.className = 'pill' + (flight.nonstop ? ' nonstop' : '');
    pill.style.background = brand.color;
    pill.dataset.brandId = flight.brandId;

    const firstSeg = flight.segments[0] ?? {};
    const flightId = firstSeg.flightNum;
    const depTime  = fmtTime(firstSeg.departure);
    const ptsStr   = flight.points ? fmtPts(flight.points) + ' pts' : '';

    pill.innerHTML = `
      <span class="badge">${brand.label}</span>
      <span>${flightId}</span>
      ${depTime ? `<span>${depTime}</span>` : ''}
      ${ptsStr  ? `<span>${ptsStr}</span>`  : ''}
      ${flight.seats <= 3 ? `<span class="seats">${flight.seats}✦</span>` : ''}
    `;

    pill.addEventListener('click', e => { e.stopPropagation(); showPopup(flight, routeKey, date); });
    return pill;
  }

  function applyFilters() {
    renderActiveTab();
  }

  // ─── POPUP ───────────────────────────────────────────────────────────────────
  function showPopup(flight, routeKey, date) {
    const existing = shadow.querySelector('.popup-overlay');
    if (existing) existing.remove();

    const brand = BRANDS[flight.brandId];
    const overlay = document.createElement('div');
    overlay.className = 'popup-overlay';

    const firstSeg = flight.segments[0] ?? {};
    const lastSeg  = flight.segments[flight.segments.length - 1] ?? {};
    const duration = fmtDuration(firstSeg.departure, lastSeg.arrival);
    const [origin, dest] = routeKey.split('→');
    const promo = g('inp-promo').value.trim();
    const bookingUrl = buildBookingUrl(origin, dest, date, promo);

    const segHTML = flight.segments.map(s => `
      <div class="seg">
        <div class="seg-row"><strong>${s.flightNum}</strong> · ${s.origin} → ${s.dest}
          ${s.operatingAirline && s.operatingAirline !== s.flightNum.slice(0,2) ? `<span style="color:#666">(operated ${s.operatingAirline})</span>` : ''}
        </div>
        <div class="seg-row">Dep <strong>${fmtTime(s.departure) || s.departure}</strong> &nbsp;|&nbsp; Arr <strong>${fmtTime(s.arrival) || s.arrival}</strong></div>
        <div class="seg-row">Cabin <strong>${s.cabinClass}</strong> · Class <strong>${s.bookingClass}</strong></div>
      </div>
    `).join('');

    overlay.innerHTML = `
      <div class="popup">
        <h3 style="color:${brand.color}">${brand.label} — ${brand.name}</h3>
        <div class="row2"><span class="lbl">Route</span><span class="val">${routeKey}</span></div>
        <div class="row2"><span class="lbl">Date</span><span class="val">${date}</span></div>
        <div class="row2"><span class="lbl">Stops</span><span class="val">${flight.nonstop ? 'Non-stop' : flight.segments.length - 1 + ' stop(s)'}</span></div>
        ${duration ? `<div class="row2"><span class="lbl">Duration</span><span class="val">${duration}</span></div>` : ''}
        <div class="row2"><span class="lbl">Seats</span><span class="val">${flight.seats ?? '?'}</span></div>
        ${flight.points ? `<div class="row2"><span class="lbl">Points</span><span class="val">${fmtPts(flight.points)}</span></div>` : ''}
        ${flight.taxAud ? `<div class="row2"><span class="lbl">Taxes</span><span class="val">$${flight.taxAud.toFixed(2)} AUD</span></div>` : ''}
        ${segHTML}
        <a class="popup-book" href="${bookingUrl}" target="_blank" rel="noopener">Book this flight →</a>
        <button class="popup-close">Close</button>
      </div>
    `;

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.popup-close').addEventListener('click', () => overlay.remove());
    shadow.appendChild(overlay);
  }

  // ─── SCAN ────────────────────────────────────────────────────────────────────
  async function startScan() {
    if (scanning) return;

    const fromVal = g('inp-date-from').value;
    const toVal   = g('inp-date-to').value;
    const promo   = g('inp-promo').value.trim();
    const routes  = getRoutes();

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (routes.length === 0) { setStatus('Enter at least one route.'); return; }
    if (!fromVal || !toVal)  { setStatus('Set both dates (YYYY-MM-DD).'); return; }
    if (!dateRe.test(fromVal) || !dateRe.test(toVal)) { setStatus('Dates must be YYYY-MM-DD format.', '#e05c5c'); return; }
    if (new Date(fromVal) > new Date(toVal)) { setStatus('From date must be before To date.'); return; }

    scanDates  = getDates(fromVal, toVal);
    scanRoutes = routes;
    totalRequests = scanDates.length * routes.length;
    completedRequests = 0;
    currentDateIndex = 0;

    if (totalRequests > 200 && !confirm(`This will make ${totalRequests} API requests (~${Math.ceil(totalRequests * DELAY_MS / 60000)} min). Continue?`)) return;

    scanning = true;
    stopRequested = false;
    g('btn-scan').disabled = true;
    g('btn-stop').disabled = false;
    setProgress(0);
    Object.keys(resultStore).forEach(k => delete resultStore[k]);
    activeTab = null;
    autoScroll = true;
    g('tab-bar').innerHTML = '';
    g('results').innerHTML = '<div id="scan-banner"><span class="spinner"></span>Scanning for availability…</div>';

    let errors = 0;

    outer: for (let di = 0; di < scanDates.length; di++) {
      if (stopRequested) break;
      const date = scanDates[di];

      for (let ri = 0; ri < scanRoutes.length; ri++) {
        if (stopRequested) break outer;
        const { origin, dest } = scanRoutes[ri];
        const routeKey = `${origin}→${dest}`;

        completedRequests = di * scanRoutes.length + ri;
        const foundSoFar = Object.keys(resultStore).length;
        const foundSuffix = foundSoFar > 0 ? ` · ${foundSoFar} date${foundSoFar !== 1 ? 's' : ''} found` : '';
        setStatus(`${date} ${routeKey} (${completedRequests + 1}/${totalRequests})${foundSuffix}`);
        setProgress(Math.round((completedRequests / totalRequests) * 100));

        try {
          const res   = await searchFlight(origin, dest, date, promo);
          const hits  = parseApiResponse(res);
          if (hits.length > 0) addResultsIncremental(date, routeKey, hits);
        } catch (e) {
          errors++;
          console.warn(`[VA Scanner] Error ${errors}/5 — ${date} ${routeKey}:`, e.message);
          if (errors >= 5) {
            console.error('[VA Scanner] Stopped after 5 errors. Possible causes: API rate limiting, missing x-sabre-storefront header, or network issue. Last storefront value:', getCapturedStorefront());
            setStatus('Stopped after 5 errors — check console (F12) for details.', '#e05c5c');
            break outer;
          }
        }

        if (!(di === scanDates.length - 1 && ri === scanRoutes.length - 1)) {
          await sleep(DELAY_MS);
        }
      }
    }

    setProgress(100);
    const banner = g('results').querySelector('#scan-banner');
    if (banner) banner.remove();
    const uniqueDates = Object.keys(resultStore).length;
    const suffix = stopRequested ? ' (stopped)' : '';
    setStatus(
      uniqueDates > 0
        ? `Done${suffix} — availability on ${uniqueDates} date(s)`
        : `Done${suffix} — no availability found`,
      uniqueDates > 0 ? '#4caf50' : '#888'
    );

    scanning = false;
    g('btn-scan').disabled = false;
    g('btn-stop').disabled = true;

    if (g('results').querySelector('.empty-msg') && uniqueDates === 0) {
      g('results').innerHTML = '<div class="empty-msg">No availability found for the selected criteria.</div>';
    }
  }

  function clearAll() {
    Object.keys(resultStore).forEach(k => delete resultStore[k]);
    activeTab = null;
    autoScroll = true;
    g('tab-bar').innerHTML = '';
    g('results').innerHTML = '<div class="empty-msg">Enter routes and dates, then press Scan.</div>';
    setProgress(0);
    g('progress-bar').style.width = '0';
    setStatus('');
  }

  // ─── INIT ────────────────────────────────────────────────────────────────────
  // Slight delay so the host DOM is fully attached
  setTimeout(() => {
    if (root.classList.contains('collapsed')) root.classList.remove('collapsed');
  }, 100);

})();
