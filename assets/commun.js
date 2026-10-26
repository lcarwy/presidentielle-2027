/* Éléments partagés par les pages : couleurs des personnalités et thème clair / sombre. */
(() => {
  'use strict';

  // Couleur fixe par personnalité (jamais par rang) ; les autres en gris.
  const COLOR = {
    'le-pen': 'violet', bardella: 'violet', melenchon: 'red', glucksmann: 'rasp',
    philippe: 'aqua', retailleau: 'blue', attal: 'yellow', tondelier: 'green', zemmour: 'ink',
  };

  window.P2027 = {
    COLOR,
    DASHED: new Set(['bardella']),
    colorOf: (k) => `var(--c-${COLOR[k] || 'other'})`,
    isMain: (k) => k in COLOR,
  };

  document.getElementById('theme-btn')?.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (e) { /* stockage indisponible */ }
  });
})();
