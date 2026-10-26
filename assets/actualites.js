/* Actualités : fil des titres de presse (data/actualites.json), filtrable par personnalité et média. */
(() => {
  'use strict';

  const NEWS_URL = 'data/actualites.json';
  const POLLS_URL = 'data/sondages.json';
  const REFRESH_MS = 10 * 60 * 1000;
  const PAGE = 60;
  const TZ = 'Europe/Paris';
  const { colorOf } = window.P2027; // assets/commun.js

  const $ = (s) => document.querySelector(s);
  const dayKey = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ }); // AAAA-MM-JJ
  const timeFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const fullFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, dateStyle: 'long', timeStyle: 'short' });
  const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

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

  const state = { news: null, names: {}, cand: '', src: '', q: '', shown: PAGE };

  const shortName = (k) => {
    const full = state.names[k] || k;
    const parts = full.split(' ');
    return (parts.length > 1 ? parts.slice(1).join(' ') : full).replace(/^(de|d')\s*/i, '');
  };

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    state.cand = p.get('candidat') || '';
    state.src = p.get('media') || '';
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.cand) p.set('candidat', state.cand);
    if (state.src) p.set('media', state.src);
    const str = p.toString();
    history.replaceState(null, '', location.pathname + location.search + (str ? `#${str}` : ''));
  }

  function filtered() {
    const q = fold(state.q.trim());
    return state.news.articles.filter((a) =>
      (!state.cand || a.candidats.includes(state.cand))
      && (!state.src || a.source === state.src)
      && (!q || fold(a.titre).includes(q)));
  }

  function renderFilters() {
    const arts = state.news.articles;
    const count = (pick) => arts.reduce((m, a) => { for (const k of pick(a)) m[k] = (m[k] || 0) + 1; return m; }, {});
    const byCand = count((a) => a.candidats);
    const bySrc = count((a) => [a.source]);
    const cands = Object.keys(byCand).sort((a, b) => byCand[b] - byCand[a] || a.localeCompare(b));
    const srcs = Object.keys(bySrc).sort((a, b) => a.localeCompare(b, 'fr'));
    if (state.cand && !byCand[state.cand]) cands.unshift(state.cand);
    $('#f-cand').replaceChildren(h('option', { value: '', text: 'Toutes' }),
      ...cands.map((k) => h('option', { value: k, text: `${state.names[k] || k} (${byCand[k] || 0})` })));
    $('#f-src').replaceChildren(h('option', { value: '', text: 'Tous les médias' }),
      ...srcs.map((s) => h('option', { value: s, text: `${s} (${bySrc[s]})` })));
    $('#f-cand').value = state.cand;
    $('#f-src').value = srcs.includes(state.src) ? state.src : '';
  }

  function renderFeed() {
    const list = filtered();
    const feed = $('#feed');
    if (!list.length) {
      feed.replaceChildren(h('p', { class: 'empty', text: 'Aucun article ne correspond à ces filtres.' }));
      $('#more-btn').hidden = true;
      return;
    }
    const today = dayKey.format(new Date());
    const yesterday = dayKey.format(new Date(Date.now() - 864e5));
    const groups = [];
    for (const a of list.slice(0, state.shown)) {
      const d = new Date(a.date);
      const key = dayKey.format(d);
      if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, d, items: [] });
      groups[groups.length - 1].items.push(a);
    }
    feed.replaceChildren(...groups.map((g) => {
      const label = g.key === today ? 'Aujourd’hui' : g.key === yesterday ? 'Hier' : dayFmt.format(g.d);
      return h('section', { class: 'news-day' },
        h('h3', { text: label.charAt(0).toUpperCase() + label.slice(1) }),
        h('ul', { class: 'news' }, g.items.map((a) => {
          const d = new Date(a.date);
          const safe = /^https?:\/\//.test(a.url);
          return h('li', { class: 'news-item' },
            h('time', { datetime: a.date, title: fullFmt.format(d), text: timeFmt.format(d) }),
            h('div', {},
              safe ? h('a', { class: 'news-title', href: a.url, target: '_blank', rel: 'noopener', text: a.titre })
                : h('span', { class: 'news-title', text: a.titre }),
              h('div', { class: 'news-meta' },
                h('span', { class: 'news-src', text: a.source }),
                a.candidats.map((k) => h('button', {
                  type: 'button', class: 'tag', title: `Voir les articles sur ${state.names[k] || k}`,
                  onclick: () => { state.cand = k; state.shown = PAGE; render(); writeHash(); window.scrollTo({ top: $('.controls').offsetTop - 70 }); },
                }, h('span', { class: 'dot', style: `background:${colorOf(k)}` }), shortName(k))))));
        })));
    }));
    const more = $('#more-btn');
    more.hidden = list.length <= state.shown;
    more.textContent = `Afficher plus d'articles (${list.length - state.shown} restants)`;
  }

  function renderMeta() {
    const n = state.news;
    const ok = n.sources.filter((s) => s.ok).length;
    $('#status').textContent = `Mis à jour le ${fullFmt.format(new Date(n.mis_a_jour))} · ${n.articles.length} articles des 14 derniers jours · ${ok}/${n.sources.length} médias consultés`;
    $('#sources').replaceChildren(...n.sources.map((s) => h('li', { class: s.ok ? '' : 'down', text: s.ok ? s.nom : `${s.nom} (indisponible lors de la dernière mise à jour)` })));
  }

  function render() {
    renderFilters();
    renderFeed();
  }

  let lastLoad = 0;
  async function load(initial) {
    if (!initial && Date.now() - lastLoad < 60 * 1000) return;
    lastLoad = Date.now();
    try {
      const [news, polls] = await Promise.all([
        fetch(`${NEWS_URL}?t=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
        initial ? fetch(POLLS_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
      ]);
      if (polls) for (const [k, c] of Object.entries(polls.candidats)) state.names[k] = c.nom;
      if (!news) {
        if (initial) $('#status').textContent = 'Les actualités apparaîtront après la prochaine mise à jour automatique.';
        return;
      }
      if (!initial && news.mis_a_jour === state.news?.mis_a_jour) return;
      state.news = news;
      renderMeta();
      render();
    } catch (e) {
      if (initial) $('#status').textContent = 'Impossible de charger les actualités pour le moment.';
      console.error(e);
    }
  }

  $('#f-cand').addEventListener('change', (e) => { state.cand = e.target.value; state.shown = PAGE; renderFeed(); writeHash(); });
  $('#f-src').addEventListener('change', (e) => { state.src = e.target.value; state.shown = PAGE; renderFeed(); writeHash(); });
  $('#f-q').addEventListener('input', (e) => { state.q = e.target.value; state.shown = PAGE; renderFeed(); });
  $('#more-btn').addEventListener('click', () => { state.shown += PAGE; renderFeed(); });
  window.addEventListener('hashchange', () => { if (state.news) { readHash(); render(); } });

  readHash();
  load(true);
  setInterval(() => load(false), REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false); });
})();
