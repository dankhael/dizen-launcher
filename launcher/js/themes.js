/**
 * Dizen — temas selecionáveis.
 *
 * Cada tema é um conjunto de variáveis CSS (as mesmas do :root em style.css).
 * Aplicado setando as variáveis no <html> e o atributo data-theme="<id>";
 * persistido em localStorage. Temas que mudam a estrutura (não só cores) têm
 * um CSS próprio em css/themes/<id>.css, escopado por html[data-theme="<id>"].
 */
(function (global) {
  'use strict';

  var THEMES = [
    {
      id: 'dizen',
      label: 'Dizen (padrão)',
      // Identidade da marca: marinho + ciano. Layout em css/themes/dizen.css.
      vars: {
        '--bg': '#070b14',
        '--bg-panel': '#0f1726',
        '--tile': '#121b2b',
        '--tile-focus': '#22d3ee',
        '--tile-focus-text': '#04141a',
        '--text': '#e6eef7',
        '--text-dim': '#8494aa',
        '--accent': '#22d3ee',
        '--radius': '22px',
        '--dz-glow': 'rgba(34, 211, 238, 0.45)',
        '--dz-edge': 'rgba(255, 255, 255, 0.07)'
      }
    },
    {
      id: 'oled',
      label: 'OLED puro',
      // Só o foco acende; pixel shift anti burn-in. Layout em css/themes/oled.css.
      vars: {
        '--bg': '#000000',
        '--bg-panel': '#000000',
        '--tile': '#000000',
        '--tile-focus': '#ffffff',
        '--tile-focus-text': '#000000',
        '--text': '#f2f2f2',
        '--text-dim': '#6e6e6e',
        '--accent': '#ffffff',
        '--radius': '28px'
      }
    },
    {
      id: 'wii',
      label: 'Canais',
      // Estrutura (dock com onda, canais 4x3, botões redondos) em css/themes/wii.css,
      // escopada por html[data-theme="wii"].
      vars: {
        '--bg': '#f6f6f6',
        '--bg-panel': '#fbfbfb',
        '--tile': '#f7f7f7',
        '--tile-focus': '#34beed',
        '--tile-focus-text': '#1d9fd6',
        '--text': '#6a6a6a',
        '--text-dim': '#9a9a9a',
        '--accent': '#34beed',
        '--radius': '24px',
        '--wii-ring': '#34beed',
        '--wii-ring-idle': '#a6def3',
        '--wii-glow': 'rgba(52, 190, 237, 0.55)',
        '--wii-border': '#cfcfcf',
        '--wii-ink': '#1d9fd6'
      }
    },
    {
      id: 'appletv',
      label: 'Vidro',
      // Estrutura (Top Shelf, grid 5 colunas, Control Center em pílula de vidro)
      // em css/themes/appletv.css, escopada por html[data-theme="appletv"].
      vars: {
        '--bg': '#07080b',
        '--bg-panel': 'rgba(36, 36, 41, 0.985)',
        '--tile': 'rgba(255, 255, 255, 0.08)',
        '--tile-focus': '#ffffff',
        '--tile-focus-text': '#111114',
        '--text': '#f5f5f7',
        '--text-dim': 'rgba(235, 235, 245, 0.6)',
        '--accent': '#0a84ff',
        '--radius': '26px',
        '--atv-glass': 'rgba(255, 255, 255, 0.10)',
        '--atv-glass-edge': 'rgba(255, 255, 255, 0.22)',
        '--atv-shadow': 'rgba(0, 0, 0, 0.6)'
      }
    },
    {
      id: 'retro',
      label: 'CRT retro',
      // Terminal de fósforo verde com scanlines. Layout em css/themes/retro.css.
      vars: {
        '--bg': '#020a03',
        '--bg-panel': '#031205',
        '--tile': '#041a07',
        '--tile-focus': '#33ff66',
        '--tile-focus-text': '#021004',
        '--text': '#33ff66',
        '--text-dim': '#1fa847',
        '--accent': '#33ff66',
        '--radius': '0px',
        '--crt-glow': 'rgba(51, 255, 102, 0.55)',
        '--crt-dim': '#0f5a22'
      }
    },
    {
      id: 'nord',
      label: 'Nord',
      // Paleta ártica, cards em lista. Layout em css/themes/nord.css.
      vars: {
        '--bg': '#2e3440',
        '--bg-panel': '#3b4252',
        '--tile': '#3b4252',
        '--tile-focus': '#88c0d0',
        '--tile-focus-text': '#2e3440',
        '--text': '#eceff4',
        '--text-dim': '#9aa5b8',
        '--accent': '#88c0d0',
        '--radius': '18px'
      }
    },
    {
      id: 'win95',
      label: 'Clássico',
      // Janela "Programas" + barra de tarefas, na linguagem do layout de live 95.
      // Layout em css/themes/win95.css.
      vars: {
        '--bg': '#008080',
        '--bg-panel': '#c0c0c0',
        '--tile': '#c0c0c0',
        '--tile-focus': '#000080',
        '--tile-focus-text': '#ffffff',
        '--text': '#000000',
        '--text-dim': '#404040',
        '--accent': '#000080',
        '--radius': '0px'
      }
    },
    {
      id: 'xp',
      label: 'Colina',
      // Luna azul clássico, morro verde, janela do Explorer + barra de tarefas.
      // Layout em css/themes/xp.css.
      vars: {
        '--bg': '#3a84e2',
        '--bg-panel': '#ece9d8',
        '--tile': '#ffffff',
        '--tile-focus': '#316ac5',
        '--tile-focus-text': '#ffffff',
        '--text': '#000000',
        '--text-dim': '#444444',
        '--accent': '#316ac5',
        '--radius': '6px'
      }
    }
  ];

  // Nomes trocados por js/local.js (window.DIZEN_LOCAL.themeLabels), se houver.
  var localLabels = (global.DIZEN_LOCAL && global.DIZEN_LOCAL.themeLabels) || {};
  for (var t = 0; t < THEMES.length; t++) {
    if (localLabels[THEMES[t].id]) THEMES[t].label = localLabels[THEMES[t].id];
  }

  var STORAGE_KEY = 'dizen.theme';

  function find(id) {
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].id === id) return THEMES[i];
    }
    return THEMES[0];
  }

  // Remove as variáveis de todos os temas antes de aplicar o novo, para que
  // variáveis exclusivas de um tema (ex.: --wii-*) não vazem para o próximo.
  function clearThemeVars(root) {
    for (var i = 0; i < THEMES.length; i++) {
      for (var key in THEMES[i].vars) {
        if (Object.prototype.hasOwnProperty.call(THEMES[i].vars, key)) {
          root.style.removeProperty(key);
        }
      }
    }
  }

  function applyTheme(id) {
    var theme = find(id);
    var root = document.documentElement;
    clearThemeVars(root);
    for (var key in theme.vars) {
      if (Object.prototype.hasOwnProperty.call(theme.vars, key)) {
        root.style.setProperty(key, theme.vars[key]);
      }
    }
    // Gancho para CSS estrutural por tema: html[data-theme="<id>"] { ... }
    root.setAttribute('data-theme', theme.id);
    return theme;
  }

  function loadTheme() {
    var saved = null;
    try { saved = global.localStorage.getItem(STORAGE_KEY); } catch (e) {}
    return applyTheme(saved || 'dizen');
  }

  function saveTheme(id) {
    try { global.localStorage.setItem(STORAGE_KEY, id); } catch (e) {}
  }

  global.DizenThemes = {
    THEMES: THEMES,
    find: find,
    applyTheme: applyTheme,
    loadTheme: loadTheme,
    saveTheme: saveTheme
  };
})(window);
