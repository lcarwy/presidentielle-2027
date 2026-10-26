/* Sondages Présidentielle 2027 — calcul de la moyenne et rendu (sans dépendance). */
(() => {
  'use strict';

  // ---------------------------------------------------------------- Réglages
  const DATA_URL = 'data/sondages.json';
  const REFRESH_MS = 10 * 60 * 1000; // vérifie les nouvelles données toutes les 10 min
  const BANDWIDTH = 12;    // lissage : écart-type du noyau gaussien, en jours
  const REACH = 3 * BANDWIDTH; // au-delà, un sondage ne compte plus
  const HALF_LIFE = 10;    // duels : le poids d'un sondage est divisé par deux tous les 10 jours
  const MIN_SHARE = 0.2;   // part minimale (pondérée) des sondages où figure une personnalité
  const DUEL_WINDOW = 60;
  const FIRST_ROUND = '2027-04-18';
  const PERIODS = { '3m': 92, '6m': 183, '1a': 366, tout: null };
  const PERIOD_LABEL = { '3m': 'depuis 3 mois', '6m': 'depuis 6 mois', '1a': 'depuis 1 an', tout: 'depuis le début' };
  const DAY = 864e5;

  const { DASHED, colorOf, isMain } = window.P2027; // assets/commun.js

  // ---------------------------------------------------------------- Outils
  const $ = (s) => document.querySelector(s);
  const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const pct = (v) => `${nf1.format(v)} %`;
  const dayOf = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };
  const fmtDay = (d, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', ...opts }).format(new Date(d * DAY));
  const todayDay = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / DAY; };
  const sizeW = (n) => Math.sqrt(Math.min(Math.max(n || 1000, 500), 3000) / 1000);
  const moe = (p, n) => 1.96 * Math.sqrt((p / 100) * (1 - p / 100) / (n || 1000)) * 100;

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
    return e;
  }
  const NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
    for (const c of kids.flat()) if (c != null) e.append(c);
    return e;
  }
  const key = (k) => h('span', { class: 'key' + (DASHED.has(k) ? ' dashed' : ''), style: `border-color:${colorOf(k)}` });
  const dot = (k) => h('span', { class: 'dot', style: `background:${colorOf(k)}` });

  // ---------------------------------------------------------------- État
  const state = {
    data: null, scenario: '', period: '6m', institut: '', hidden: new Set(),
    shown: 20, open: new Set(), oldDuels: false,
    polls: [], series: null, current: {}, ranked: [], today: todayDay(),
  };

  const fullName = (k) => state.data.candidats[k]?.nom || k;
  const party = (k) => state.data.candidats[k]?.parti || '';
  const shortName = (k) => {
    const parts = fullName(k).split(' ');
    return (parts.length > 1 ? parts.slice(1).join(' ') : parts[0]).replace(/^(de|d')\s*/i, '');
  };

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('scenario')) state.scenario = p.get('scenario');
    if (p.get('periode') in PERIODS) state.period = p.get('periode');
    if (p.get('institut')) state.institut = p.get('institut');
  }
  function stateHash() {
    const p = new URLSearchParams();
    if (state.scenario) p.set('scenario', state.scenario);
    if (state.period !== '6m') p.set('periode', state.period);
    if (state.institut) p.set('institut', state.institut);
    const str = p.toString();
    return str ? `#${str}` : '';
  }
  function writeHash() {
    history.replaceState(null, '', location.pathname + location.search + stateHash());
  }

  // ---------------------------------------------------------------- Calculs
  /** Moyenne des hypothèses de chaque sondage (filtrées par scénario). Tri : plus récent d'abord. */
  function preparePolls() {
    const out = [];
    for (const p of state.data.sondages) {
      const hyps = state.scenario ? p.hypotheses.filter((x) => state.scenario in x) : p.hypotheses;
      if (!hyps.length) continue;
      const sum = {}, cnt = {}, lo = {}, hi = {};
      for (const hyp of hyps) {
        for (const [k, v] of Object.entries(hyp)) {
          sum[k] = (sum[k] || 0) + v;
          cnt[k] = (cnt[k] || 0) + 1;
          lo[k] = Math.min(lo[k] ?? Infinity, v);
          hi[k] = Math.max(hi[k] ?? -Infinity, v);
        }
      }
      const vals = {};
      for (const k in sum) vals[k] = sum[k] / cnt[k];
      out.push({ ...p, day: dayOf(p.fin), vals, lo, hi, hyps });
    }
    return out.sort((a, b) => b.day - a.day || a.institut.localeCompare(b.institut));
  }

  /**
   * Moyenne lissée au jour t : noyau gaussien centré sur t (les sondages postérieurs à
   * aujourd'hui n'existant pas, la valeur du jour ne dépend que du passé), pondéré par la
   * taille d'échantillon ; « un institut, une voix » : le poids total d'un institut est
   * plafonné à celui d'un sondage du jour.
   */
  function averageAt(polls, t) {
    const byInst = {}, acc = {};
    for (const p of polls) {
      const dd = t - p.day;
      if (dd < -REACH) continue;
      if (dd > REACH) break;
      (byInst[p.institut] ||= []).push([p, Math.exp(-0.5 * (dd / BANDWIDTH) ** 2), dd]);
    }
    let total = 0;
    for (const items of Object.values(byInst)) {
      const K = items.reduce((sum, it) => sum + it[1], 0);
      const scale = Math.min(K, 1) / K;
      for (const [p, kern, dd] of items) {
        const w = kern * scale * sizeW(p.echantillon);
        total += w;
        const near = Math.abs(dd) <= 2 * BANDWIDTH;
        for (const k in p.vals) {
          const a = acc[k] || (acc[k] = { w: 0, s: 0, n: 0, lo: Infinity, hi: -Infinity });
          a.w += w; a.s += w * p.vals[k];
          if (near) { a.n += 1; a.lo = Math.min(a.lo, p.lo[k]); a.hi = Math.max(a.hi, p.hi[k]); }
        }
      }
    }
    const res = {};
    for (const k in acc) if (acc[k].w >= MIN_SHARE * total) res[k] = { v: acc[k].s / acc[k].w, n: acc[k].n, lo: acc[k].lo, hi: acc[k].hi };
    return res;
  }

  function computeSeries(polls) {
    if (!polls.length) return { first: state.today, days: 0, values: new Map() };
    const first = polls[polls.length - 1].day;
    const days = state.today - first + 1;
    const values = new Map();
    for (let i = 0; i < days; i++) {
      const avg = averageAt(polls, first + i);
      for (const k in avg) {
        if (!values.has(k)) values.set(k, new Float32Array(days).fill(NaN));
        values.get(k)[i] = avg[k].v;
      }
    }
    return { first, days, values };
  }
  const valueAt = (k, d) => {
    const S = state.series, arr = S.values.get(k);
    if (!arr) return null;
    const v = arr[d - S.first];
    return Number.isFinite(v) ? v : null;
  };
  const periodStart = () => {
    const n = PERIODS[state.period];
    return n ? Math.max(state.today - n, state.series.first) : state.series.first;
  };

  function recompute() {
    state.today = todayDay();
    state.polls = preparePolls();
    state.series = computeSeries(state.polls);
    state.current = averageAt(state.polls, state.today);
    state.ranked = Object.keys(state.current).sort((a, b) => state.current[b].v - state.current[a].v);
  }

  // ---------------------------------------------------------------- Rendu : en-tête
  function renderHeader() {
    const left = dayOf(FIRST_ROUND) - state.today;
    $('#countdown').textContent = left > 1 ? `J-${left} avant le premier tour (18 avril 2027)`
      : left === 1 ? 'Premier tour demain, 18 avril 2027' : left === 0 ? "Premier tour aujourd'hui" : 'Premier tour le 18 avril 2027';

    const d = state.data;
    const upd = new Date(d.mis_a_jour);
    const when = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(upd);
    const last = d.sondages.reduce((m, p) => (p.fin > m ? p.fin : m), '');
    $('#status').textContent = `Données mises à jour le ${when} · ${d.sondages.length} sondages · dernier terrain le ${fmtDay(dayOf(last), { day: 'numeric', month: 'long' })} · source : Wikipédia`;

    const lede = $('#summary');
    const [a, b, c] = state.ranked;
    if (!b) { lede.textContent = 'Pas assez de sondages récents pour ce scénario.'; return; }
    const cur = state.current;
    const strong = (k) => h('strong', { text: fullName(k) });
    const parts = ['Si le premier tour avait lieu aujourd’hui, ', strong(a), ` (${pct(cur[a].v)}) et `, strong(b), ` (${pct(cur[b].v)}) arriveraient en tête`];
    if (state.scenario) parts.push(` dans les hypothèses avec ${fullName(state.scenario)}`);
    parts.push('.');
    if (c) {
      const gap = Math.round((cur[b].v - cur[c].v) * 10) / 10;
      parts.push(` ${fullName(c)} (${pct(cur[c].v)}) suit à ${nf1.format(gap)} point${gap >= 2 ? 's' : ''} de la deuxième place`);
      parts.push(gap < 3 ? ', un écart inférieur à la marge d’erreur des sondages.' : '.');
    }
    lede.replaceChildren(...parts);
  }

  function renderScenarioOptions() {
    const sel = $('#scenario');
    const since = state.today - 180;
    const recent = state.data.sondages.filter((p) => dayOf(p.fin) >= since);
    const hyps = recent.flatMap((p) => p.hypotheses);
    const polls = {}, count = {};
    for (const p of recent) for (const k of new Set(p.hypotheses.flatMap(Object.keys))) polls[k] = (polls[k] || 0) + 1;
    for (const x of hyps) for (const k in x) count[k] = (count[k] || 0) + 1;
    let opts = Object.keys(count)
      .filter((k) => count[k] / hyps.length >= 0.08 && count[k] / hyps.length <= 0.92 && polls[k] >= 2)
      .sort((a, b) => (state.current[b]?.v ?? 0) - (state.current[a]?.v ?? 0) || count[b] - count[a]);
    if (state.scenario && !opts.includes(state.scenario) && state.data.candidats[state.scenario]) opts = [state.scenario, ...opts];
    if (state.scenario && !state.data.candidats[state.scenario]) state.scenario = '';
    sel.replaceChildren(
      h('option', { value: '', text: 'Toutes les hypothèses' }),
      ...opts.map((k) => h('option', { value: k, text: `Avec ${fullName(k)}` })),
    );
    sel.value = state.scenario;
  }

  // ---------------------------------------------------------------- Rendu : classement
  function renderRanking() {
    const list = $('#ranking');
    const cur = state.current;
    const start = periodStart();
    $('#ranking-sub').textContent = `Moyenne lissée des sondages des quatre dernières semaines${state.scenario ? `, hypothèses avec ${fullName(state.scenario)}` : ''}. Évolution ${PERIOD_LABEL[state.period]}.`;
    if (!state.ranked.length) { list.replaceChildren(h('li', { class: 'empty', text: 'Aucun sondage récent pour ce scénario.' })); return; }
    const max = Math.max(40, Math.ceil(cur[state.ranked[0]].v / 5) * 5);
    const head = h('li', { class: 'rank-head', 'aria-hidden': 'true' },
      h('span', { text: 'Personnalité' }), h('span'), h('span', { text: 'Moyenne' }), h('span', { text: 'Évol.' }));
    const rows = state.ranked.map((k, i) => {
      const c = cur[k];
      const ref = valueAt(k, start);
      const diff = ref == null ? null : Math.round((c.v - ref) * 10) / 10;
      const delta = diff == null ? h('span', { class: 'delta flat', text: 'nouveau' })
        : Math.abs(diff) < 0.1 ? h('span', { class: 'delta flat', text: '=' })
          : h('span', { class: 'delta', text: `${diff > 0 ? '▲ +' : '▼ −'}${nf1.format(Math.abs(diff))}` });
      const title = c.n
        ? `${fullName(k)} : ${pct(c.v)} en moyenne. Fourchette des sondages récents : ${nf.format(c.lo)} – ${nf.format(c.hi)} % (${c.n} sondage${c.n > 1 ? 's' : ''}).`
        : `${fullName(k)} : ${pct(c.v)} en moyenne.`;
      return h('li', { class: 'rank-row' + (i < 2 ? ' qualified' : ''), title },
        h('span', { class: 'name' }, dot(k), h('strong', { text: shortName(k) }), h('small', { text: party(k) })),
        h('span', { class: 'bar-track', 'aria-hidden': 'true' },
          h('span', { class: 'bar-fill', style: `width:${(c.v / max) * 100}%;background:${colorOf(k)}` }),
          c.n > 1 && c.hi > c.lo ? h('span', { class: 'bar-range', style: `left:${(c.lo / max) * 100}%;width:${((c.hi - c.lo) / max) * 100}%` }) : null),
        h('span', { class: 'value', text: pct(c.v) }),
        delta,
        h('span', { class: 'sr-only', text: title }),
      );
    });
    list.replaceChildren(head, ...rows);
  }

  // ---------------------------------------------------------------- Rendu : graphique
  let chartKeys = [];
  function chartCandidates(x0, x1) {
    const keys = [];
    for (const [k, arr] of state.series.values) {
      let max = -1;
      for (let d = x0; d <= x1; d++) { const v = arr[d - state.series.first]; if (v > max) max = v; }
      if (max < 0) continue;
      if (isMain(k) || (valueAt(k, x1) != null && max >= 3)) keys.push(k);
    }
    const last = (k) => valueAt(k, x1) ?? -1;
    return keys.sort((a, b) => last(b) - last(a) || a.localeCompare(b));
  }

  function renderLegend() {
    const x0 = periodStart(), x1 = state.today;
    chartKeys = chartCandidates(x0, x1);
    $('#legend').replaceChildren(...chartKeys.map((k) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(!state.hidden.has(k)),
      onclick: () => { state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k); renderLegend(); drawChart(); },
    }, key(k), shortName(k))));
  }

  let hover = null; // jour survolé
  function drawChart() {
    const box = $('#chart');
    const tip = $('#tooltip');
    box.querySelector('svg')?.remove();
    const W = Math.max(box.clientWidth, 280);
    const mobile = W < 560;
    const H = mobile ? 320 : 390;
    const x0 = periodStart(), x1 = state.today;
    const visible = chartKeys.filter((k) => !state.hidden.has(k));
    // Étiquettes de fin : sur mobile, seulement les personnalités en couleur
    const endKeys = visible.filter((k) => valueAt(k, x1) != null && (!mobile || isMain(k)));
    const ctx = (drawChart.ctx ||= document.createElement('canvas').getContext('2d'));
    const family = getComputedStyle(box).fontFamily;
    const labelW = (k) => {
      ctx.font = `12.5px ${family}`;
      const a = ctx.measureText(`${shortName(k)} `).width;
      ctx.font = `650 12.5px ${family}`;
      return a + ctx.measureText(nf1.format(valueAt(k, x1))).width;
    };
    const m = { t: 14, r: Math.min(Math.max(40, ...endKeys.map(labelW)) + 22, W * 0.42), b: 30, l: 38 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const polls = state.polls.filter((p) => p.day >= x0 && p.day <= x1);

    let ymax = 20;
    for (const k of visible) for (let d = x0; d <= x1; d++) { const v = valueAt(k, d); if (v > ymax) ymax = v; }
    for (const p of polls) for (const k of visible) if (p.vals[k] > ymax) ymax = p.vals[k];
    ymax = Math.ceil((ymax + 1) / 5) * 5;
    const X = (d) => m.l + ((d - x0) / Math.max(x1 - x0, 1)) * pw;
    const Y = (v) => m.t + ph - (v / ymax) * ph;

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, tabindex: 0, role: 'img',
      'aria-label': `Évolution de la moyenne des sondages ${PERIOD_LABEL[state.period]}. Flèches gauche et droite pour parcourir les dates.` });

    // Grille et axes
    const grid = s('g');
    const step = ymax > 30 ? 10 : 5;
    for (let v = 0; v <= ymax; v += step) {
      grid.append(s('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), style: `stroke:${v === 0 ? 'var(--axis)' : 'var(--grid)'}`, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
      grid.append(s('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis-label' }, v === 0 ? '0' : `${v} %`));
    }
    const months = [];
    const d0 = new Date(x0 * DAY);
    for (let y = d0.getUTCFullYear(), mo = d0.getUTCMonth() + 1; ; mo++) {
      const t = Date.UTC(y, mo, 1) / DAY;
      if (t > x1) break;
      months.push(t);
    }
    const every = [1, 2, 3, 4, 6, 12].find((n) => months.length / n <= (mobile ? 4 : 7)) || 12;
    months.filter((t, i) => (months.length - 1 - i) % every === 0).forEach((t, i) => {
      const date = new Date(t * DAY);
      const label = fmtDay(t, { month: 'short' }) + (i === 0 || date.getUTCMonth() === 0 ? ` ${date.getUTCFullYear()}` : '');
      grid.append(s('line', { x1: X(t), x2: X(t), y1: m.t + ph, y2: m.t + ph + 5, style: 'stroke:var(--axis)', 'shape-rendering': 'crispEdges' }));
      grid.append(s('text', { x: X(t), y: m.t + ph + 20, 'text-anchor': 'middle', class: 'axis-label' }, label));
    });
    svg.append(grid);

    // Sondages individuels
    const dots = s('g');
    const ordered = [...visible].reverse();
    for (const p of polls) {
      for (const k of ordered) {
        if (p.vals[k] == null) continue;
        dots.append(s('circle', { cx: X(p.day), cy: Y(p.vals[k]), r: mobile ? 2.6 : 3.2, style: `fill:${colorOf(k)}`, 'fill-opacity': isMain(k) ? 0.32 : 0.45 }));
      }
    }
    svg.append(dots);

    // Lignes de moyenne (les grises dessous)
    const lines = s('g', { fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    const drawOrder = [...visible.filter((k) => !isMain(k)), ...visible.filter(isMain).reverse()];
    for (const k of drawOrder) {
      let dpath = '', pen = false;
      for (let d = x0; d <= x1; d++) {
        const v = valueAt(k, d);
        if (v == null) { pen = false; continue; }
        dpath += `${pen ? 'L' : 'M'}${X(d).toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      }
      if (dpath) lines.append(s('path', { d: dpath, style: `stroke:${colorOf(k)}`, 'stroke-width': isMain(k) ? 2.25 : 1.5, 'stroke-dasharray': DASHED.has(k) ? '6 4' : null }));
    }
    svg.append(lines);

    // Étiquettes de fin de ligne (sans chevauchement, avec trait de rappel)
    const ends = endKeys.map((k) => ({ k, v: valueAt(k, x1), y: Y(valueAt(k, x1)) }));
    ends.sort((a, b) => a.y - b.y);
    const gap = 15;
    ends.forEach((e, i) => { e.ly = i ? Math.max(e.y, ends[i - 1].ly + gap) : e.y; });
    const bottom = m.t + ph + 4;
    for (let i = ends.length - 1; i >= 0; i--) {
      const lim = i === ends.length - 1 ? bottom : ends[i + 1].ly - gap;
      if (ends[i].ly > lim) ends[i].ly = lim;
    }
    const labels = s('g');
    const xe = X(x1);
    for (const e of ends) {
      if (Math.abs(e.ly - e.y) > 1.5) labels.append(s('path', { d: `M${xe + 6},${e.y}L${xe + 12},${e.ly}`, style: 'stroke:var(--axis)', fill: 'none' }));
      labels.append(s('circle', { cx: xe, cy: e.y, r: 4, style: `fill:${colorOf(e.k)};stroke:var(--surface)`, 'stroke-width': 2 }));
      labels.append(s('text', { x: xe + 15, y: e.ly + 4, class: 'end-label' },
        s('tspan', {}, `${shortName(e.k)} `), s('tspan', { class: 'v' }, nf1.format(e.v))));
    }
    svg.append(labels);

    // Couche de survol : réticule + bulle
    const cross = s('g', { visibility: 'hidden', 'pointer-events': 'none' });
    const vline = s('line', { y1: m.t, y2: m.t + ph, style: 'stroke:var(--ink-2)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' });
    cross.append(vline);
    const markers = s('g');
    cross.append(markers);
    svg.append(cross);
    const hit = s('rect', { x: m.l, y: m.t, width: pw + 8, height: ph, fill: 'transparent' });
    svg.append(hit);

    function show(day) {
      hover = Math.min(Math.max(day, x0), x1);
      const x = X(hover);
      vline.setAttribute('x1', x); vline.setAttribute('x2', x);
      const rows = visible.map((k) => ({ k, v: valueAt(k, hover) })).filter((r) => r.v != null).sort((a, b) => b.v - a.v);
      markers.replaceChildren(...rows.map((r) => s('circle', { cx: x, cy: Y(r.v), r: 4, style: `fill:${colorOf(r.k)};stroke:var(--surface)`, 'stroke-width': 2 })));
      cross.setAttribute('visibility', 'visible');
      const recent = state.polls.find((p) => p.day <= hover);
      tip.replaceChildren(
        h('div', { class: 't-date', text: fmtDay(hover, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) }),
        h('div', { class: 't-rows' }, rows.length
          ? rows.map((r) => h('div', { class: 't-row' }, key(r.k), h('b', { text: pct(r.v) }), h('span', { text: shortName(r.k) })))
          : h('div', { text: 'Pas de sondage récent' })),
        recent && hover - recent.day <= REACH ? h('div', { class: 't-polls', text: `Dernier sondage : ${recent.institut}, ${fmtDay(recent.day, { day: 'numeric', month: 'short' })}` }) : null,
      );
      tip.hidden = false;
      tip.classList.toggle('docked', mobile);
      if (mobile) return; // sur mobile, l'encart est fixe sous le graphique
      const tw = tip.offsetWidth;
      let left = x + 14;
      if (left + tw > W) left = x - tw - 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${m.t}px`;
    }
    function hide() {
      if (mobile) return;
      hover = null; cross.setAttribute('visibility', 'hidden'); tip.hidden = true;
    }
    const dayFromEvent = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      return Math.round(x0 + ((px - m.l) / pw) * (x1 - x0));
    };
    hit.addEventListener('pointermove', (ev) => show(dayFromEvent(ev)));
    hit.addEventListener('pointerdown', (ev) => show(dayFromEvent(ev)));
    hit.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') hide(); });
    svg.addEventListener('focus', () => show(hover ?? x1));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (ev) => {
      const stepD = ev.shiftKey ? 7 : 1;
      const cur = hover ?? x1;
      if (ev.key === 'ArrowLeft') show(cur - stepD);
      else if (ev.key === 'ArrowRight') show(cur + stepD);
      else if (ev.key === 'Home') show(x0);
      else if (ev.key === 'End') show(x1);
      else if (ev.key === 'Escape') { svg.blur(); return; } else return;
      ev.preventDefault();
    });
    box.prepend(svg);
    if (hover != null || mobile) show(hover ?? x1); else tip.hidden = true;
  }

  // ---------------------------------------------------------------- Rendu : duels
  function duelStats(d) {
    const polls = d.sondages.map((x) => ({ ...x, day: dayOf(x.fin) })).sort((a, b) => b.day - a.day);
    const latest = polls[0].day;
    const recent = state.today - latest <= DUEL_WINDOW;
    const ref = recent ? state.today : latest;
    const rank = {};
    let w = 0, sa = 0, sb = 0, n = 0;
    for (const p of polls) {
      if (p.day <= ref - DUEL_WINDOW) break;
      const r = (rank[p.institut] = (rank[p.institut] ?? -1) + 1);
      const ww = 0.5 ** ((ref - p.day) / HALF_LIFE) * 0.5 ** r * sizeW(p.echantillon);
      w += ww; sa += ww * p.a; sb += ww * p.b; n += 1;
    }
    const tot = sa + sb;
    return { ...d, polls, latest, recent, n, va: (sa / tot) * 100, vb: (sb / tot) * 100 };
  }

  function renderDuels() {
    const all = state.data.duels.filter((d) => d.sondages.length).map(duelStats)
      .filter((d) => state.today - d.latest <= 366)
      .sort((a, b) => b.recent - a.recent || b.n - a.n || b.latest - a.latest);
    const recent = all.filter((d) => d.recent);
    const shown = state.oldDuels || !recent.length ? all : recent;
    const more = $('#duels-more');
    more.hidden = state.oldDuels || shown.length === all.length;

    $('#duels').replaceChildren(...shown.map((d) => {
      const [L, R] = d.va >= d.vb ? [[d.a, d.va], [d.b, d.vb]] : [[d.b, d.vb], [d.a, d.va]];
      const last = d.polls[0];
      const foot = d.recent
        ? `Moyenne de ${d.n} sondage${d.n > 1 ? 's' : ''} · dernier : ${last.institut}, ${fmtDay(d.latest, { day: 'numeric', month: 'short' })}`
        : `Pas de sondage depuis le ${fmtDay(d.latest, { day: 'numeric', month: 'long', year: 'numeric' })}`;
      const details = d.polls.slice(0, 6).map((p) => {
        const [va, vb] = L[0] === d.a ? [p.a, p.b] : [p.b, p.a];
        return `${p.institut} (${fmtDay(p.day, { day: 'numeric', month: 'short' })}) : ${nf.format(va)} – ${nf.format(vb)}`;
      }).join('\n');
      return h('article', { class: 'duel' + (d.recent ? '' : ' old'), title: `Derniers sondages :\n${details}` },
        h('div', { class: 'duel-names' },
          h('span', {}, dot(L[0]), h('strong', { text: shortName(L[0]) })),
          h('span', {}, dot(R[0]), h('strong', { text: shortName(R[0]) }))),
        h('div', { class: 'duel-vals' }, h('span', { text: pct(L[1]) }), h('span', { text: pct(R[1]) })),
        h('div', { class: 'split', role: 'img', 'aria-label': `${fullName(L[0])} ${pct(L[1])}, ${fullName(R[0])} ${pct(R[1])}` },
          h('div', { style: `width:${L[1]}%;background:${colorOf(L[0])}` }),
          h('div', { style: `width:${R[1]}%;background:${colorOf(R[0])}` }),
          h('span', { class: 'mid' })),
        h('p', { class: 'duel-foot', text: foot }));
    }));
  }

  // ---------------------------------------------------------------- Rendu : tableau
  function renderInstituts() {
    const sel = $('#institut');
    const names = [...new Set(state.data.sondages.map((p) => p.institut))].sort((a, b) => a.localeCompare(b, 'fr'));
    if (state.institut && !names.includes(state.institut)) state.institut = '';
    sel.replaceChildren(h('option', { value: '', text: 'Tous les instituts' }), ...names.map((n) => h('option', { value: n, text: n })));
    sel.value = state.institut;
  }

  function cellText(lo, hi) { return lo === hi ? nf.format(lo) : `${nf.format(lo)}–${nf.format(hi)}`; }

  function renderTable() {
    const table = $('#polls-table');
    const x0 = periodStart();
    const polls = state.polls.filter((p) => p.day >= x0 && (!state.institut || p.institut === state.institut));
    $('#table-sub').textContent = `${polls.length} sondage${polls.length > 1 ? 's' : ''} ${PERIOD_LABEL[state.period]}${state.scenario ? ` (hypothèses avec ${fullName(state.scenario)})` : ''}. Fourchette des hypothèses testées ; cliquez sur une ligne pour le détail.`;
    if (!polls.length) {
      table.replaceChildren(h('tbody', {}, h('tr', {}, h('td', { class: 'empty', text: 'Aucun sondage pour ces filtres.' }))));
      $('#more-btn').hidden = true;
      return;
    }
    const present = new Set(polls.flatMap((p) => Object.keys(p.vals)));
    const order = [...state.ranked, ...[...present].filter((k) => !state.ranked.includes(k))];
    const cols = order.filter((k) => present.has(k)).slice(0, 8);
    const others = (vals) => Object.keys(vals).filter((k) => !cols.includes(k)).sort((a, b) => vals[b] - vals[a]);

    const thead = h('thead', {}, h('tr', {},
      h('th', { text: 'Terrain' }), h('th', { text: 'Institut' }), h('th', { text: 'Éch.' }),
      ...cols.map((k) => h('th', { title: fullName(k) }, key(k), shortName(k)))));
    const tbody = h('tbody');
    for (const p of polls.slice(0, state.shown)) {
      const open = state.open.has(p.id);
      const best = Math.max(...Object.values(p.vals));
      const row = h('tr', { class: 'main' + (open ? ' open' : ''), tabindex: 0, 'aria-expanded': String(open) },
        h('td', {}, h('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }), ' ', fmtDay(p.day, { day: 'numeric', month: 'short', year: '2-digit' })),
        h('td', {}, p.notice
          ? h('a', { class: 'inst', href: p.notice, target: '_blank', rel: 'noopener', title: 'Notice officielle du sondage', onclick: (e) => e.stopPropagation(), text: p.institut })
          : h('span', { class: 'inst', text: p.institut }), p.hyps.length > 1 ? h('span', { class: 'n', text: ` · ${p.hyps.length} hyp.` }) : null),
        h('td', { class: 'n', text: p.echantillon ? nf.format(p.echantillon) : '–' }),
        ...cols.map((k) => (p.vals[k] == null
          ? h('td', { class: 'na', text: '–' })
          : h('td', { class: p.vals[k] === best ? 'lead' : null, title: `${fullName(k)} : ${cellText(p.lo[k], p.hi[k])} % · marge d'erreur ±${nf1.format(moe(p.vals[k], p.echantillon))} pt` }, cellText(p.lo[k], p.hi[k])))));
      const toggle = () => { open ? state.open.delete(p.id) : state.open.add(p.id); renderTable(); };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      tbody.append(row);
      if (open) {
        p.hyps.forEach((hyp, i) => {
          const top = Math.max(...Object.values(hyp));
          tbody.append(h('tr', { class: 'hyp' },
            h('td', { colspan: 3, text: `Hypothèse ${i + 1}` }),
            ...cols.map((k) => h('td', { class: hyp[k] === top ? 'lead' : (hyp[k] == null ? 'na' : null), text: hyp[k] == null ? '–' : nf.format(hyp[k]) }))));
          const rest = others(hyp);
          if (rest.length) {
            tbody.append(h('tr', { class: 'hyp extra-row' }, h('td', { colspan: cols.length + 3, text: `Autres : ${rest.map((k) => `${shortName(k)} ${nf.format(hyp[k])}`).join(' · ')}` })));
          }
        });
      }
    }
    table.replaceChildren(thead, tbody);
    const more = $('#more-btn');
    more.hidden = polls.length <= state.shown;
    more.textContent = `Afficher plus de sondages (${polls.length - state.shown} restants)`;
  }

  // ---------------------------------------------------------------- Orchestration
  function renderAll() {
    renderScenarioOptions();
    renderInstituts();
    renderHeader();
    renderRanking();
    renderLegend();
    drawChart();
    renderDuels();
    renderTable();
    document.querySelectorAll('#period button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.p === state.period)));
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  let lastLoad = 0;
  async function load(initial) {
    if (!initial && Date.now() - lastLoad < 60 * 1000) return;
    lastLoad = Date.now();
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      const dayChanged = todayDay() !== state.today;
      if (!initial && data.mis_a_jour === state.data?.mis_a_jour && !dayChanged) return;
      const fresh = !initial && data.mis_a_jour !== state.data?.mis_a_jour;
      state.data = data;
      recompute();
      renderAll();
      if (fresh) toast('Nouveaux sondages : la page vient d’être mise à jour.');
    } catch (e) {
      if (initial) $('#summary').textContent = 'Impossible de charger les sondages pour le moment. Réessayez dans quelques instants.';
      console.error(e);
    }
  }

  function bind() {
    $('#scenario').addEventListener('change', (e) => {
      state.scenario = e.target.value; state.open.clear();
      recompute(); renderAll(); writeHash();
    });
    $('#period').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-p]');
      if (!b) return;
      state.period = b.dataset.p; state.shown = 20; hover = null;
      renderAll(); writeHash();
    });
    $('#period').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const keys = Object.keys(PERIODS);
      const i = (keys.indexOf(state.period) + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length;
      state.period = keys[i]; hover = null;
      renderAll(); writeHash();
      $(`#period button[data-p="${keys[i]}"]`).focus();
    });
    $('#institut').addEventListener('change', (e) => { state.institut = e.target.value; state.shown = 20; renderTable(); writeHash(); });
    $('#more-btn').addEventListener('click', () => { state.shown += 20; renderTable(); });
    $('#duels-more').addEventListener('click', () => { state.oldDuels = true; renderDuels(); });
    $('#share-btn').addEventListener('click', async () => {
      const url = location.origin + location.pathname + location.search + stateHash();
      try { await navigator.clipboard.writeText(url); toast('Lien copié dans le presse-papiers'); } catch (e) { window.prompt('Copiez ce lien :', url); }
    });
    let raf = 0, lastW = 0;
    new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (!state.data || Math.abs(w - lastW) < 1) return;
      lastW = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(drawChart);
    }).observe($('#chart'));

    // Lien vers le dépôt quand le site est servi par GitHub Pages
    const host = location.hostname.match(/^([^.]+)\.github\.io$/);
    if (host) {
      const repo = location.pathname.split('/').filter(Boolean)[0];
      $('#repo-link').href = `https://github.com/${host[1]}${repo ? `/${repo}` : ''}`;
    }
  }

  readHash();
  bind();
  // Lien partagé ouvert dans un onglet déjà chargé
  window.addEventListener('hashchange', () => {
    const p = new URLSearchParams(location.hash.slice(1));
    if (!state.data || !['scenario', 'periode', 'institut'].some((k) => p.has(k))) return;
    state.scenario = ''; state.period = '6m'; state.institut = '';
    readHash();
    recompute(); renderAll();
  });
  load(true);
  setInterval(() => load(false), REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false); });
})();
