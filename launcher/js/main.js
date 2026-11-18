/**
 * Dizen — launcher minimalista para Samsung Tizen TV.
 *
 * Sem framework, sem build step. ES6 (Chromium M85 no Tizen 6.5 suporta).
 *
 * - Lista de apps curada (window.DIZEN_APPS, gerada por tools/sync-apps.sh),
 *   com fallback para tizen.application.getAppsInfo e modo demo.
 * - Abre apps via root agent do Vetro no IP LAN da TV.
 * - Engrenagem abre temas e ordenação (persistidos em localStorage).
 * - Navegação por tema: grid flat (padrão/Apple TV/...) e páginas 4x3
 *   horizontais no tema Wii.
 */
(function () {
  'use strict';

  var VETRO_PORT = 8099;
  var WII_COLS = 4, WII_ROWS = 3, WII_PER = WII_COLS * WII_ROWS;

  var stage = document.querySelector('.stage');
  var grid = document.getElementById('grid');
  // Fundo e cartões do tema Wii por WebGL (js/wii-gl.js); sem WebGL, fica o CSS.
  var wiiGL = window.DizenWiiGL;
  wiiGL.init(grid, isWii);
  var empty = document.getElementById('empty');
  var clockEl = document.getElementById('clock');
  var dateEl = document.getElementById('date');
  var settingsBtn = document.getElementById('settings-btn');
  var launchStatusEl = document.getElementById('launch-status');
  var wiiAmbience = document.getElementById('wii-ambience');
  // Personalização local (js/local.js). Ausente no público: sem música, sem aparelhos extras.
  var LOCAL = window.DIZEN_LOCAL || {};
  if (LOCAL.ambience) wiiAmbience.src = LOCAL.ambience;
  var shelfArt = document.getElementById('apple-shelf-art');
  var shelfImage = document.getElementById('apple-shelf-image');
  var shelfFallback = document.getElementById('apple-shelf-fallback');
  var shelfTint = document.getElementById('apple-shelf-tint');
  var shelfTitle = document.getElementById('apple-shelf-title');
  var overlay = document.getElementById('settings-overlay');
  var themeListEl = document.getElementById('theme-list');
  var orderListEl = document.getElementById('app-order-list');
  var themeTab = document.getElementById('theme-tab');
  var orderTab = document.getElementById('order-tab');
  var hdmiTab = document.getElementById('hdmi-tab');
  var hdmiListEl = document.getElementById('hdmi-list');
  var panelHint = document.getElementById('panel-hint');
  var previewMode = /(?:^|[?&])preview=1(?:&|$)/.test(window.location.search);

  var apps = [];          // { id, name, icon, fallback }
  var tileEls = [];       // elementos .tile na ordem dos apps
  var gridCols = 0;
  var focusIndex = -1;
  var focusOnGear = false;
  var overlayOpen = false;
  var themeIndex = -1;
  var currentThemeId = 'dizen';
  var settingsPane = 'themes';
  var orderIndex = 0;
  var hdmiIndex = 0;
  var movingApp = false;
  var orderSnapshot = null;
  var focusedOrderEl = null;
  var APP_ORDER_KEY = 'dizen.appOrder';
  var LAST_FOCUS_KEY = 'dizen.lastFocus';
  var LAST_APP_KEY = 'dizen.lastApp';
  var HDMI_DEVICES_KEY = 'dizen.hdmiDevices';
  var CONTINUE_ID = 'dizen.action.continue';
  var lastFocusedId = readSavedId(LAST_FOCUS_KEY);
  var lastAppId = readSavedId(LAST_APP_KEY);
  var focusSaveTimer = null;
  var launchLockUntil = 0;
  var launchStatusTimer = null;
  var wiiScrollFrame = 0;
  var wiiScrollTarget = null;

  /* ------------------------------------------------------------------ */
  /* Clock                                                              */
  /* ------------------------------------------------------------------ */

  // Sete segmentos em traço de ponta redonda (o desenho do relógio do Wii
  // Menu): quatro dígitos vetoriais, criados uma vez. Aceso/apagado é a classe
  // "on"; a cor, a espessura e o "fantasma" dos apagados ficam no CSS do tema.
  var SEGMENT_PATHS = [
    'M3.9 2H10.1',      // a: topo
    'M12 3.9V9.1',     // b: direita superior
    'M12 12.9V18.1',   // c: direita inferior
    'M3.9 20H10.1',     // d: base
    'M2 12.9V18.1',    // e: esquerda inferior
    'M2 3.9V9.1',      // f: esquerda superior
    'M3.9 11H10.1'      // g: centro
  ];
  var DIGIT_SEGMENTS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc',
                        'afgcd', 'afgcde', 'abc', 'abcdefg', 'abfgcd'];
  var WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
                  'quinta-feira', 'sexta-feira', 'sábado'];
  var WEEKDAYS_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  var clockSegments = [];
  var clockDigits = [];
  var lastClockMinute = '';
  var lastDate = '';
  var dateLongEl = dateEl.querySelector('.date-long');
  var dateShortEl = dateEl.querySelector('.date-short');

  function makeSvg(viewBox, className) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  }

  function buildClock() {
    for (var i = 0; i < 4; i++) {
      if (i === 2) {
        var colon = makeSvg('0 0 6 22', 'clock-colon');
        for (var c = 0; c < 2; c++) {
          var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          dot.setAttribute('cx', '3');
          dot.setAttribute('cy', c ? '15.5' : '6.5');
          dot.setAttribute('r', '1.5');
          colon.appendChild(dot);
        }
        clockEl.appendChild(colon);
      }
      var svg = makeSvg('0 0 14 22', 'clock-digit');
      var segments = [];
      for (var j = 0; j < SEGMENT_PATHS.length; j++) {
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', SEGMENT_PATHS[j]);
        svg.appendChild(path);
        segments.push(path);
      }
      clockSegments.push(segments);
      clockDigits.push(svg);
      clockEl.appendChild(svg);
    }
  }

  function tickClock() {
    var now = new Date();
    var h = String(now.getHours()).padStart(2, '0');
    var m = String(now.getMinutes()).padStart(2, '0');
    var time = h + m;
    if (time !== lastClockMinute) {
      for (var i = 0; i < time.length; i++) {
        var active = DIGIT_SEGMENTS[Number(time.charAt(i))];
        for (var j = 0; j < 7; j++) {
          clockSegments[i][j].classList.toggle('on', active.indexOf('abcdefg'.charAt(j)) >= 0);
        }
      }
      // O Wii mostra "3:45", não "03:45": o tema decide se esconde o zero.
      clockDigits[0].classList.toggle('lead-zero', h.charAt(0) === '0');
      clockEl.setAttribute('aria-label', h + ':' + m);
      lastClockMinute = time;
    }
    var date = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate();
    if (date !== lastDate) {
      var dayMonth = String(now.getDate()).padStart(2, '0') + '/' + String(now.getMonth() + 1).padStart(2, '0');
      dateLongEl.textContent = WEEKDAYS[now.getDay()] + ' · ' + dayMonth + '/' + now.getFullYear();
      dateShortEl.textContent = WEEKDAYS_SHORT[now.getDay()] + ' ' + dayMonth;
      lastDate = date;
    }
  }
  buildClock();
  setInterval(tickClock, 15000);
  tickClock();

  /* ------------------------------------------------------------------ */
  /* Tema                                                               */
  /* ------------------------------------------------------------------ */

  function initTheme() {
    currentThemeId = DizenThemes.loadTheme().id;
    syncThemeTimers();
    syncMotion();
  }

  /*
   * Movimento "infinito" dos temas por timer, não por animação CSS.
   *
   * Medido na TV: qualquer animação CSS infinita de opacity/transform roda no
   * compositor, e nesta TV ele não limita a taxa de quadros — a thread
   * "Compositor" fica em ~100% de um núcleo enquanto a animação existir, mesmo
   * com `steps()` e com a tela parada. O cursor do CRT e o pixel shift do OLED
   * mudam poucas vezes por minuto, então um setInterval dá o mesmo efeito com
   * CPU zero entre as trocas.
   */
  var brandEl = document.querySelector('.brand');
  var driftEls = [document.querySelector('.topbar'), stage, document.querySelector('.hintbar')];
  var themeTimer = null;

  function setDrift(value) {
    for (var i = 0; i < driftEls.length; i++) driftEls[i].style.transform = value;
  }

  function syncThemeTimers() {
    wiiGL.sync();     // liga o WebGL no Wii e desliga nos demais temas
    clearInterval(themeTimer);
    themeTimer = null;
    brandEl.classList.remove('cursor-off');
    setDrift('');
    if (currentThemeId === 'retro') {
      // cursor do prompt: 0,55 s aceso / 0,55 s apagado
      themeTimer = setInterval(function () { brandEl.classList.toggle('cursor-off'); }, 550);
    } else if (currentThemeId === 'oled') {
      // pixel shift anti burn-in: 1 px por minuto, de (-3,-2) a (3,2) e volta
      var step = 0;
      var shift = function () {
        var x = (step <= 6 ? step : 12 - step) - 3;
        setDrift('translate(' + x + 'px, ' + Math.round(x * 2 / 3) + 'px)');
        step = (step + 1) % 12;
      };
      shift();
      themeTimer = setInterval(shift, 60000);
    }
  }

  function isWii() { return currentThemeId === 'wii'; }

  /* ------------------------------------------------------------------ */
  /* Movimento do tema Wii                                              */
  /* ------------------------------------------------------------------ */

  /*
   * Regra da casa (medida na TV): nada de animação CSS infinita — ela prende
   * o compositor em ~100% de um núcleo. Todo movimento aqui é um TIMER que
   * dispara uma transição/animação FINITA e curta; entre um disparo e outro
   * não há quadro nenhum sendo produzido.
   *
   *   - dois-pontos do relógio: 1 s acesos / 1 s apagados (troca de classe);
   *   - "canal vivo": com o controle parado, um canal da página visível
   *     esmaece o ícone e mostra o nome grande por ~2,6 s, como os canais do
   *     Wii Menu alternam arte e título. Um por vez, nunca o focado, em
   *     poucos passos (liveTween);
   *   - mascote da dock pisca os olhos de vez em quando;
   *   - entrada: a página visível surge ao abrir/voltar ao launcher.
   *
   * Qualquer tecla cancela o canal vivo e reinicia a espera; tudo para com o
   * launcher oculto, com as configurações abertas ou fora do tema Wii.
   */
  var LIVE_IDLE_MS = 6000;    // controle parado até o primeiro canal vivo
  var LIVE_SHOW_MS = 2600;    // quanto tempo o nome fica em destaque
  var LIVE_GAP_MS = 7000;     // pausa entre um canal e o próximo
  var LIVE_STEPS = 5;         // quadros de cada ida/volta (ver liveTween)
  var LIVE_STEP_MS = 70;
  var BLINK_EVERY_MS = 6400;
  var colonTimer = null;
  var liveTimer = null;
  var liveStepTimer = null;
  var blinkTimer = null;
  var liveTile = null;
  var liveScale = 1;
  var lastLiveTile = null;
  var enteredOnce = false;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function motionAllowed() {
    return isWii() && !document.hidden && !reducedMotion;
  }

  // progress 0 = canal normal, 1 = ícone esmaecido e nome grande no centro.
  function setLive(tile, progress) {
    var art = tile.firstElementChild;      // .icon ou .fallback
    var label = tile.querySelector('.label');
    if (progress <= 0) {
      art.style.opacity = '';
      label.style.transform = '';
      return;
    }
    art.style.opacity = String(1 - 0.86 * progress);
    label.style.transform = 'translateY(' + (-64 * progress).toFixed(1) + 'px) scale(' +
      (1 + (liveScale - 1) * progress).toFixed(3) + ')';
  }

  /*
   * Interpolação em POUCOS passos por timer, não transição CSS. Medido na TV:
   * cada quadro composto custa ~30 ms de CPU, então uma transição de 0,45 s
   * (≈27 quadros, quatro por ciclo) levava o launcher parado de 4% para 33% de
   * um núcleo. Cinco passos dão o mesmo efeito com 5 quadros. O ícone e o
   * rótulo já são camadas (will-change no wii.css), então nenhum passo
   * re-rasteriza a página.
   */
  function liveTween(tile, from, to, done) {
    var step = 0;
    clearInterval(liveStepTimer);
    liveStepTimer = setInterval(function () {
      step++;
      var t = step / LIVE_STEPS;
      var eased = 1 - (1 - t) * (1 - t);
      setLive(tile, from + (to - from) * eased);
      if (step >= LIVE_STEPS) {
        clearInterval(liveStepTimer);
        liveStepTimer = null;
        if (done) done();
      }
    }, LIVE_STEP_MS);
  }

  // Corte seco: usado quando o usuário mexe no controle ou o tema muda.
  function endLive() {
    clearInterval(liveStepTimer);
    liveStepTimer = null;
    if (liveTile) {
      setLive(liveTile, 0);
      liveTile.classList.remove('wii-live');
    }
    liveTile = null;
  }

  function playLive() {
    var cur = tileAt(focusIndex);
    var page = cur && cur.parentElement;
    if (overlayOpen || !motionAllowed()) return;
    if (!page) { liveTimer = setTimeout(playLive, LIVE_GAP_MS); return; }
    var pool = [];
    for (var i = 0; i < page.children.length; i++) {
      var t = page.children[i];
      if (t !== cur && t !== lastLiveTile) pool.push(t);
    }
    if (!pool.length) { liveTimer = setTimeout(playLive, LIVE_GAP_MS); return; }
    var tile = liveTile = lastLiveTile = pool[Math.floor(Math.random() * pool.length)];
    // Nome curto cresce mais; nome longo cresce só até caber no canal.
    liveScale = Math.max(1, Math.min(1.7, 330 / Math.max(tile.querySelector('.label').offsetWidth, 1)));
    tile.classList.add('wii-live');
    liveTween(tile, 0, 1);
    liveTimer = setTimeout(function () {
      liveTween(tile, 1, 0, function () {
        tile.classList.remove('wii-live');
        liveTile = null;
      });
      liveTimer = setTimeout(playLive, LIVE_GAP_MS);
    }, LIVE_SHOW_MS);
  }

  // Chamado a cada tecla: cancela o canal vivo e recomeça a contar o repouso.
  function restartLive() {
    clearTimeout(liveTimer);
    liveTimer = null;
    endLive();
    if (motionAllowed() && !overlayOpen) liveTimer = setTimeout(playLive, LIVE_IDLE_MS);
  }

  function blinkMascot() {
    brandEl.classList.add('blink');
    setTimeout(function () { brandEl.classList.remove('blink'); }, 150);
  }

  function playEnter() {
    var cur = tileAt(focusIndex);
    var page = cur && cur.parentElement;
    if (!page || !motionAllowed()) return;
    if (wiiGL.enter(page)) return;       // com WebGL a entrada é por JS, junto com o GL
    page.classList.remove('wii-enter');
    void page.offsetWidth;               // reinicia a animação se já tinha rodado
    page.classList.add('wii-enter');
    setTimeout(function () { page.classList.remove('wii-enter'); }, 500);
  }

  function syncMotion() {
    clearInterval(colonTimer);
    clearInterval(blinkTimer);
    colonTimer = blinkTimer = null;
    clockEl.classList.remove('colon-off');
    brandEl.classList.remove('blink');
    restartLive();
    if (!motionAllowed()) return;
    colonTimer = setInterval(function () { clockEl.classList.toggle('colon-off'); }, 1000);
    blinkTimer = setInterval(blinkMascot, BLINK_EVERY_MS);
  }

  var ambienceBlocked = false;

  function playAmbience() {
    if (!LOCAL.ambience || !isWii() || document.hidden || wiiAmbience.error) return;
    var playback = wiiAmbience.play();
    if (playback && playback.then) {
      playback.then(function () { ambienceBlocked = false; }, function (err) {
        ambienceBlocked = err && err.name === 'NotAllowedError';
      });
    }
  }

  function syncAmbience() {
    if (isWii()) {
      wiiAmbience.volume = 0.3;
      playAmbience();
    } else {
      wiiAmbience.pause();
      wiiAmbience.currentTime = 0;
      ambienceBlocked = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* App data                                                           */
  /* ------------------------------------------------------------------ */

  function readSavedId(key) {
    try { return localStorage.getItem(key) || ''; }
    catch (e) { return ''; }
  }

  function saveFocus() {
    clearTimeout(focusSaveTimer);
    focusSaveTimer = null;
    if (!lastFocusedId) return;
    try { localStorage.setItem(LAST_FOCUS_KEY, lastFocusedId); }
    catch (e) { console.error('Não foi possível salvar o foco', e); }
  }

  function rememberFocus(app) {
    if (!app) return;
    lastFocusedId = app.id;
    clearTimeout(focusSaveTimer);
    // Uma escrita depois que a navegação para; nunca uma escrita por tecla.
    focusSaveTimer = setTimeout(saveFocus, 1200);
  }

  function makeContinue(target) {
    return {
      id: CONTINUE_ID, name: 'Continuar: ' + target.name,
      icon: target.icon, fallback: target.fallback,
      continueTargetId: target.id, system: true
    };
  }

  function refreshContinue(renderChanged) {
    if (!apps.length) return;
    var target = null, existing = -1;
    for (var i = 0; i < apps.length; i++) {
      if (apps[i].id === CONTINUE_ID) existing = i;
      else if (apps[i].id === lastAppId) target = apps[i];
    }
    if (!target || target.id === 'dizen.sys.home' || target.id === 'dizen.sys.settings') {
      if (existing >= 0) { apps.splice(existing, 1); if (renderChanged !== false) render(); }
      return;
    }
    if (existing < 0) {
      apps.unshift(makeContinue(target));
      applySavedOrder();
      if (renderChanged !== false) render();
    } else if (apps[existing].continueTargetId !== target.id ||
               apps[existing].name !== 'Continuar: ' + target.name) {
      apps[existing] = makeContinue(target);
      if (renderChanged !== false) replaceTile(existing);
    }
  }

  // Troca só um tile, sem render(): recriar o grid faz o Chromium recarregar e
  // decodificar todos os ícones (loading=lazy) e redesenhar tudo na volta do Home.
  function replaceTile(index) {
    var old = tileEls[index];
    if (!old || !old.parentNode || old.dataset.appId !== apps[index].id) { render(); return; }
    var tile = buildTile(apps[index], index);
    old.parentNode.replaceChild(tile, old);
    tileEls[index] = tile;
    wiiGL.syncCard(tile);
    if (index === focusIndex && !focusOnGear) focusTile(index);
    restartLive();   // a animação "ao vivo" pode estar no tile que saiu
  }

  function getSelfId(cb) {
    if (!window.tizen) return cb(null);
    try {
      tizen.application.getCurrentApplication().getAppInfo(function (info) {
        cb(info && info.id);
      }, function () { cb(null); });
    } catch (e) { cb(null); }
  }

  /*
   * Entradas de sistema: TV aberta, Samsung TV Plus, HDMI e o menu da TV.
   *
   * Não são apps instaláveis, então não vêm do sync-apps.sh: cada uma é um
   * comando fixo executado pelo root agent do Vetro (POST /exec), o mesmo
   * caminho que abre os apps. Verificado na TV (50Q60B):
   *  - a tecla XF86Discret* troca a entrada, mas a janela do launcher continua
   *    na frente; por isso o comando traz o org.tizen.tv-viewer (o app nativo
   *    que exibe TV/HDMI) para o primeiro plano. A ORDEM importa: viewer
   *    primeiro, 1 s, depois a tecla. Com a tecla antes (ou sem a pausa) a
   *    troca falha de vez em quando — o viewer reassume a entrada anterior;
   *  - o app "Samsung TV Plus" (tvPlusDeeplinker) não faz nada sem deep link;
   *    o que funciona é pedir ao tv-viewer um canal do TV Plus pelo id de
   *    serviço, que o sync-apps.sh lê da TV e grava em window.DIZEN_SYSTEM;
   *  - org.tizen.menu é o menu de configurações completo da Samsung;
   *  - com.samsung.tv.csfs é a Home original da Samsung.
   */
  var HDMI_PORTS = 3;   // a 50Q60B tem 3; a tecla XF86DiscretHDMI4 não faz nada nela
  var VIEWER_CMD = '/usr/bin/app_launcher -s org.tizen.tv-viewer';
  var SOURCE_CMD = VIEWER_CMD + '; sleep 1; /usr/bin/input_keyevent ';

  /*
   * Aparelho de cada porta HDMI: troca o nome e o ícone da entrada.
   * A API pública do Tizen não diz qual aparelho está ligado (só "conectado"),
   * então a escolha é do usuário (Configurações > Entradas HDMI, salva em
   * localStorage). Sem escolha, vale o que a própria Samsung detectou, lido do
   * cache dela pelo tools/sync-apps.sh (window.DIZEN_SYSTEM.hdmi). 'generic' é
   * escolha explícita de "nenhum", para vencer a detecção.
   */
  // Aparelhos além do genérico vêm de js/local.js (DIZEN_LOCAL.hdmiDevices).
  var HDMI_DEVICES = [{ id: 'generic', name: null, icon: null }].concat(LOCAL.hdmiDevices || []);
  var hdmiChoice = {};
  try { hdmiChoice = JSON.parse(localStorage.getItem(HDMI_DEVICES_KEY)) || {}; }
  catch (e) { hdmiChoice = {}; }

  function hdmiDevice(port) {
    var detected = (window.DIZEN_SYSTEM || {}).hdmi || {};
    var id = hdmiChoice[port] || detected[port] || 'generic';
    for (var i = 0; i < HDMI_DEVICES.length; i++) {
      if (HDMI_DEVICES[i].id === id) return HDMI_DEVICES[i];
    }
    return HDMI_DEVICES[0];
  }

  function hdmiEntry(port) {
    var device = hdmiDevice(port);
    return {
      name: device.name || 'HDMI ' + port,
      icon: device.icon || 'icons/sys-hdmi' + port + '.svg'
    };
  }

  function systemApps() {
    var sys = window.DIZEN_SYSTEM || {};
    // TV aberta e TV Plus são a MESMA entrada (TV) e a mesma lista de canais
    // (TV Plus = canais >= 2000), e a tecla de entrada volta ao último canal,
    // seja de qual for. Por isso "TV Digital" sintoniza um canal aberto fixo
    // (sys.tv, escolhido no sync-apps.sh); sem ele, cai na tecla de entrada.
    var hasChannel = function (c) { return c && /^[0-9]+$/.test(c.svcid); };
    var tune = function (c) {
      return VIEWER_CMD + ' __APP_SVC_OP_TYPE__ http://tizen.org/appcontrol/operation/view svcid ' + c.svcid;
    };
    var list = [{
      id: 'dizen.sys.tv', name: 'TV Digital', icon: 'icons/sys-tv.svg',
      cmd: hasChannel(sys.tv) ? tune(sys.tv) : SOURCE_CMD + 'XF86DiscretSourceTV'
    }];
    if (hasChannel(sys.tvplus)) {
      list.push({
        id: 'dizen.sys.tvplus', name: 'Samsung TV Plus', icon: 'icons/sys-tvplus.svg',
        cmd: tune(sys.tvplus)
      });
    }
    for (var n = 1; n <= HDMI_PORTS; n++) {
      var entry = hdmiEntry(n);
      list.push({
        id: 'dizen.sys.hdmi' + n, name: entry.name, icon: entry.icon,
        cmd: SOURCE_CMD + 'XF86DiscretHDMI' + n
      });
    }
    list.push({
      id: 'dizen.sys.settings', name: 'Configurações da TV', icon: 'icons/sys-settings.svg',
      cmd: '/usr/bin/app_launcher -s org.tizen.menu'
    });
    // Saída de emergência: a Home original da Samsung (First Screen).
    list.push({
      id: 'dizen.sys.home', name: 'Home Samsung', icon: 'icons/sys-home.svg',
      cmd: '/usr/bin/app_launcher -s com.samsung.tv.csfs'
    });
    for (var i = 0; i < list.length; i++) {
      list[i].system = true;
      list[i].fallback = list[i].name.charAt(0);
    }
    return list;
  }

  function loadApps() {
    if (!window.tizen || previewMode) {
      apps = systemApps().concat(demoApps());
      applySavedOrder();
      refreshContinue(false);
      render();
      return;
    }
    // 1) lista curada (sync-apps.sh) — rápida, filtrada, com ícones.
    if (window.DIZEN_APPS && window.DIZEN_APPS.length) {
      onAppsJson(window.DIZEN_APPS);
      return;
    }
    // 2) fallback: getAppsInfo (sem o filtro fino de sistema).
    getSelfId(function (id) {
      var selfId = id;
      try {
        tizen.application.getAppsInfo(function (list) {
          onApps(list, selfId);
        }, onAppsError);
      } catch (e) { onAppsError(e); }
    });
  }

  /*
   * Lista viva: o plugin dizen-sync do Vetro (plugin/dizen-sync) mantém apps,
   * ícones, canais e aparelhos HDMI em dia dentro da TV e responde em
   * /plugins/dizen-sync/api/state. Consultado ao abrir, ao voltar para a frente
   * e a cada minuto enquanto visível; a própria consulta faz o plugin conferir
   * na hora. Só redesenha o grid se a revisão mudou. Sem plugin (ou em preview)
   * nada acontece e vale o js/apps.js estático.
   */
  var PLUGIN_POLL_MS = 60000;
  var pluginTimer = null;
  var resumeSent = false;

  function syncFromPlugin() {
    if (!window.tizen || previewMode) return;
    try {
      var rev = window.DIZEN_REV || '';
      fetch(vetroOrigin() + '/plugins/dizen-sync/api/state' + (rev ? '?rev=' + rev : ''), { cache: 'no-store' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!data || !data.rev || data.unchanged || data.rev === window.DIZEN_REV) return;
          if (!data.apps || !data.apps.length || movingApp) return;
          window.DIZEN_APPS = data.apps;
          window.DIZEN_SYSTEM = data.system || {};
          window.DIZEN_REV = data.rev;
          orderListEl.innerHTML = '';     // a lista de ordem mostra nomes: refaz ao abrir
          focusedOrderEl = null;
          onAppsJson(data.apps);
          if (overlayOpen && settingsPane !== 'themes') setSettingsPane(settingsPane);
        })
        .catch(function () {
          // Plugin sem responder. Uma causa conhecida: depois de uma queda de
          // energia logo no boot, o Vetro sobe os plugins em "modo seguro"
          // (suspensos). O resume limpa essa marca para o PRÓXIMO boot; é
          // inofensivo se o motivo for outro. Uma vez por sessão.
          if (resumeSent) return;
          resumeSent = true;
          try { fetch(vetroOrigin() + '/plugins/resume', { method: 'POST', mode: 'no-cors' }).catch(function () {}); }
          catch (e) { /* sem rede: nada a fazer */ }
        });
    } catch (e) { /* sem IP da TV ou fetch indisponível: fica com a lista estática */ }
  }

  function syncPluginTimer() {
    clearInterval(pluginTimer);
    pluginTimer = null;
    if (document.hidden) return;
    syncFromPlugin();
    pluginTimer = setInterval(syncFromPlugin, PLUGIN_POLL_MS);
  }

  function onAppsJson(list) {
    apps = systemApps();
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || !it.id) continue;
      apps.push({
        id: it.id,
        name: it.name || it.id,
        icon: it.icon || '',
        fallback: (it.name || it.id).charAt(0).toUpperCase()
      });
    }
    applySavedOrder();
    refreshContinue(false);
    render();
  }

  function onApps(infoList, selfId) {
    apps = systemApps();
    for (var i = 0; i < infoList.length; i++) {
      var info = infoList[i];
      if (info.show === false) continue;
      if (selfId && info.id === selfId) continue;
      apps.push({
        id: info.id,
        name: info.name || info.id,
        icon: info.iconPath ? 'file://' + info.iconPath : '',
        fallback: (info.name || info.id).charAt(0).toUpperCase()
      });
    }
    applySavedOrder();
    refreshContinue(false);
    render();
  }

  function onAppsError(err) {
    empty.hidden = false;
    empty.textContent = 'Não foi possível listar os apps: ' + (err && err.message ? err.message : err);
  }

  function applySavedOrder() {
    var saved;
    try { saved = JSON.parse(localStorage.getItem(APP_ORDER_KEY)); }
    catch (e) { return; }
    if (!Array.isArray(saved)) return;
    var ranks = Object.create(null);
    for (var i = 0; i < saved.length; i++) {
      if (typeof saved[i] === 'string' && ranks[saved[i]] === undefined) ranks[saved[i]] = i;
    }
    // Fora da ordem salva: app novo vai pro fim; entrada de sistema nova vai
    // pro começo (senão ficaria escondida atrás de todos os apps).
    function rank(app) {
      if (ranks[app.id] !== undefined) return ranks[app.id];
      return app.system ? -1 : Infinity;
    }
    apps.sort(function (a, b) {
      var ar = rank(a), br = rank(b);
      return ar === br ? 0 : ar - br;   // Infinity - Infinity seria NaN
    });
  }

  function saveAppOrder() {
    try { localStorage.setItem(APP_ORDER_KEY, JSON.stringify(apps.map(function (app) { return app.id; }))); }
    catch (e) { console.error('Não foi possível salvar a ordem dos apps', e); }
  }

  function demoApps() {
    var names = ['YouTube', 'Netflix', 'Prime Video', 'Spotify', 'Globoplay',
                 'Disney+', 'HBO Max', 'Twitch', 'Plex', 'Kodi', 'Steam Link', 'Configurações',
                 'Apple TV', 'Crunchyroll', 'discovery+', 'GeForce NOW', 'Xbox',
                 'YouTube Music', 'Internet', 'Jellyfin', 'Stremio', 'Paramount+',
                 'Pluto TV', 'Samsung TV Plus', 'Deezer'];
    return names.map(function (n, i) {
      return { id: 'demo.' + i, name: n, icon: '', fallback: n.charAt(0) };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                             */
  /* ------------------------------------------------------------------ */

  function render() {
    var focused = tileEls[focusIndex];
    var restoreId = focused ? focused.dataset.appId : lastFocusedId;
    cancelAnimationFrame(wiiScrollFrame);
    wiiScrollFrame = 0;
    wiiScrollTarget = null;
    grid.innerHTML = '';
    grid.style.scrollBehavior = '';
    tileEls = [];
    empty.hidden = apps.length > 0;

    if (isWii()) {
      // páginas 4x3 lado a lado (rolagem horizontal)
      var pages = Math.ceil(apps.length / WII_PER);
      for (var p = 0; p < pages; p++) {
        var page = document.createElement('div');
        page.className = 'wii-page';
        for (var j = 0; j < WII_PER; j++) {
          var idx = p * WII_PER + j;
          if (idx >= apps.length) break;
          var t = buildTile(apps[idx], idx);
          page.appendChild(t);
          tileEls.push(t);
        }
        grid.appendChild(page);
      }
    } else {
      for (var i = 0; i < apps.length; i++) {
        var tile = buildTile(apps[i], i);
        grid.appendChild(tile);
        tileEls.push(tile);
      }
    }

    gridCols = 0;
    focusOnGear = false;
    if (apps.length > 0) {
      var restoreIndex = apps.findIndex(function (app) { return app.id === restoreId; });
      focusTile(restoreIndex >= 0 ? restoreIndex : 0);
    } else {
      focusIndex = -1;
      setShelfHidden(true);
    }
    restartLive();   // os tiles antigos saíram do DOM
    wiiGL.sync();    // tiles novos: classes do cartão e redesenho (ou liga o WebGL)
    if (!enteredOnce && apps.length > 0) {
      enteredOnce = true;
      playEnter();
    }
  }

  function buildTile(app, index) {
    var tile = document.createElement('div');
    tile.className = 'tile';
    tile.setAttribute('role', 'gridcell');
    tile.setAttribute('tabindex', '-1');
    tile.dataset.index = index;
    tile.dataset.appId = app.id;

    if (app.icon) {
      var img = document.createElement('img');
      img.className = 'icon';
      img.alt = '';
      img.loading = 'lazy';      // não decodifica ícones fora da tela no boot
      img.decoding = 'async';    // não bloqueia o layout na decodificação
      img.src = app.icon;
      img.onerror = function () {
        this.remove();
        tile.insertBefore(makeFallback(app.fallback), tile.firstChild);
      };
      tile.appendChild(img);
    } else {
      tile.appendChild(makeFallback(app.fallback));
    }

    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = app.name;
    tile.appendChild(label);

    tile.addEventListener('click', function () { launch(parseInt(this.dataset.index, 10)); });
    return tile;
  }

  function syncTileOrder() {
    var focused = tileEls[focusIndex];
    var restoreId = focused && focused.dataset.appId;
    var byId = Object.create(null);
    for (var i = 0; i < tileEls.length; i++) byId[tileEls[i].dataset.appId] = tileEls[i];
    var ordered = [];
    for (var j = 0; j < apps.length; j++) {
      var tile = byId[apps[j].id];
      tile.dataset.index = j;
      if (isWii()) grid.children[Math.floor(j / WII_PER)].appendChild(tile);
      else grid.appendChild(tile);
      ordered.push(tile);
    }
    tileEls = ordered;
    wiiGL.draw();     // os tiles mudaram de lugar
    var restoreIndex = apps.findIndex(function (app) { return app.id === restoreId; });
    focusTile(restoreIndex >= 0 ? restoreIndex : 0);
  }

  function makeFallback(letter) {
    var div = document.createElement('div');
    div.className = 'fallback';
    div.textContent = letter;
    return div;
  }

  function tileAt(index) { return tileEls[index] || null; }

  function keepTileVisible(tile) {
    // scrollIntoView pode mover também .stage (overflow:hidden) no Chromium da TV.
    // Calcule só o deslocamento necessário no container que guarda os apps.
    var viewport = grid.getBoundingClientRect();
    var target = tile.getBoundingClientRect();
    var style = getComputedStyle(grid);
    var top = viewport.top + (parseFloat(style.paddingTop) || 0);
    var bottom = viewport.bottom - (parseFloat(style.paddingBottom) || 0);
    if (target.top < top) grid.scrollTop += target.top - top;
    else if (target.bottom > bottom) grid.scrollTop += target.bottom - bottom;
  }

  function setShelfHidden(hidden) {
    shelfArt.hidden = hidden;
    shelfTitle.hidden = hidden;
    if (hidden) paintShelfBackdrop(null);
  }

  // Paleta do Top Shelf (espelha o :nth-child do appletv.css). O título e a
  // tinta são elementos fixos NO BODY (não pseudo-elementos dentro do tile),
  // para o tile poder usar transform: scale() no foco — barato na GPU, sem
  // reflow. A tinta é um <canvas>: ver paintShelfBackdrop().
  var ATV_PALETTE = [
    ['#ff375f', '#ff9f0a'],
    ['#0a84ff', '#5e5ce6'],
    ['#30d158', '#0a9396'],
    ['#bf5af2', '#5e5ce6'],
    ['#ff9f0a', '#ff453a'],
    ['#64d2ff', '#0a84ff'],
    ['#ff453a', '#a2134f'],
    ['#8e8e93', '#2c2c2e']
  ];

  function syncShelfArt(app, index) {
    var isAtv = currentThemeId === 'appletv';
    setShelfHidden(!app || !isAtv);
    if (!app || !isAtv) return;
    shelfTitle.textContent = app.name;
    shelfFallback.textContent = app.fallback;
    shelfFallback.hidden = !!app.icon;
    shelfImage.hidden = !app.icon;
    if (app.icon && shelfImage.getAttribute('src') !== app.icon) shelfImage.src = app.icon;
    paintShelfBackdrop(ATV_PALETTE[(index || 0) % ATV_PALETTE.length]);
  }

  /*
   * Fundo do Top Shelf (Apple TV) num <canvas> de baixa resolução.
   *
   * Medido na TV: o raster do Chromium M85 aqui é por software, e gradiente
   * radial grande é caro. A tinta era um elemento de 1920x640 com 2 radiais +
   * 1 linear + opacity, recolorido a cada tecla: >1 s de CPU de raster por
   * tecla (as duas threads de raster saturadas).
   * Agora o mesmo desenho é feito em 384x128 (1/5) e esticado pelo CSS — o
   * raster vira um blit de bitmap. Como é só brilho difuso, não se nota.
   *
   * Camadas (de baixo pra cima), coordenadas em px de tela 1920x640:
   *   1. brilho azulado do "wallpaper" (era um radial no fundo do html)
   *   2. tinta do app focado: radial c2 + radial c1 + esmaecer pra baixo, a 50%
   *   3. halo atrás da arte do app (era .apple-shelf-art::before)
   * pal = [c1, c2] do app focado, ou null (engrenagem/sem app): só a camada 1.
   */
  var SHELF_SCALE = shelfTint.width / 1920;
  var shelfCtx = shelfTint.getContext('2d');
  var shelfGroup = document.createElement('canvas');
  shelfGroup.width = shelfTint.width;
  shelfGroup.height = shelfTint.height;
  var shelfGroupCtx = shelfGroup.getContext('2d');
  var shelfPainted = null;

  function rgba(hex, alpha) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  // Equivale a `radial-gradient(ellipse <rx> <ry> at <cx> <cy>, from, to)`.
  function shelfEllipse(ctx, cx, cy, rx, ry, from, to) {
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, from);
    g.addColorStop(1, to);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx, ry);
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  function paintShelfBackdrop(pal) {
    var isAtv = currentThemeId === 'appletv';
    shelfTint.hidden = !isAtv;
    if (!isAtv) return;
    var key = pal ? pal.join() : 'none';
    if (key === shelfPainted) return;
    shelfPainted = key;

    var ctx = shelfCtx, w = shelfTint.width, h = shelfTint.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.scale(SHELF_SCALE, SHELF_SCALE);
    shelfEllipse(ctx, 288, 0, 1152, 540, 'rgba(70,90,140,0.30)', 'rgba(70,90,140,0)');
    if (!pal) return;

    var g = shelfGroupCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.scale(SHELF_SCALE, SHELF_SCALE);
    shelfEllipse(g, 672, 0, 864, 448, pal[1], rgba(pal[1], 0));
    shelfEllipse(g, 1536, 64, 1056, 544, pal[0], rgba(pal[0], 0));
    var fade = g.createLinearGradient(0, 0, 0, 640);
    fade.addColorStop(0.45, 'rgba(7,8,11,0)');
    fade.addColorStop(1, '#07080b');
    g.fillStyle = fade;
    g.fillRect(0, 0, 1920, 640);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(shelfGroup, 0, 0);
    ctx.globalAlpha = 1;

    // halo: círculo que zera em 176px, recortado na elipse 430x290 da arte
    ctx.scale(SHELF_SCALE, SHELF_SCALE);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(1555, 289, 215, 145, 0, 0, 2 * Math.PI);
    ctx.clip();
    shelfEllipse(ctx, 1555, 289, 176, 176, 'rgba(255,255,255,0.18)', 'rgba(255,255,255,0)');
    ctx.restore();
  }

  shelfImage.onerror = function () {
    this.hidden = true;
    shelfFallback.hidden = false;
  };

  function scrollWiiPage(page) {
    var target = Math.min(page.offsetLeft - grid.firstElementChild.offsetLeft,
      grid.scrollWidth - grid.clientWidth);
    // Teclas repetidas dentro da mesma página não reiniciam a transição.
    if (wiiScrollFrame && target === wiiScrollTarget) return;
    cancelAnimationFrame(wiiScrollFrame);
    wiiScrollFrame = 0;
    wiiScrollTarget = target;
    var start = grid.scrollLeft;
    if (Math.abs(target - start) < 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      var moved = grid.scrollLeft !== target;
      grid.scrollLeft = target;
      // Toda tecla passa por aqui: só redesenhe o GL se a página andou de fato
      // (redesenhar 1080p custa ~10 ms da GPU e atrasa o quadro da tecla).
      if (moved) wiiGL.draw();
      return;
    }
    // O smooth nativo do Chromium M85 leva ~750 ms para atravessar uma página.
    // Limite a 240 ms e retome da posição atual se a direção mudar no meio.
    var started = performance.now();
    function step(now) {
      var progress = Math.min((now - started) / 240, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      grid.scrollLeft = start + (target - start) * eased;
      wiiGL.drawNow();   // já estamos no rAF: o GL rola no mesmo quadro que o DOM
      wiiScrollFrame = progress < 1 ? requestAnimationFrame(step) : 0;
    }
    wiiScrollFrame = requestAnimationFrame(step);
  }

  function focusTile(index) {
    clearGridFocus();
    focusIndex = index;
    focusOnGear = false;
    var cur = tileAt(focusIndex);
    if (cur) {
      rememberFocus(apps[index]);
      cur.classList.add('focus');
      wiiGL.syncCard(cur);   // o focado pinta o próprio cartão em CSS, por cima do do GL
      syncShelfArt(apps[index], index);
      if (isWii()) {
        // Mova a página inteira; scrollIntoView também pode rolar o eixo vertical
        // e não avança de modo confiável neste flex container no Chromium da TV.
        scrollWiiPage(cur.parentElement);
      } else {
        // Uma chamada anterior de scrollIntoView pode ter rolado .stage.
        // A navegação dos temas em grade deve mover somente .grid.
        stage.scrollTop = 0;
        grid.style.scrollBehavior = 'auto';
        if (index < columnCount()) grid.scrollTop = 0;
        else keepTileVisible(cur);
      }
    }
  }

  function focusGear() {
    clearGridFocus();
    focusOnGear = true;
    setShelfHidden(true);
    if (currentThemeId === 'appletv') {
      shelfTitle.hidden = false;
      shelfTitle.textContent = 'Configurações';
    }
    settingsBtn.classList.add('focus');
    settingsBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function clearGridFocus() {
    var focused = tileAt(focusIndex);
    if (focused) {
      focused.classList.remove('focus');
      wiiGL.hold(focused);   // cartão em CSS até a escala voltar a 1
    }
    settingsBtn.classList.remove('focus');
  }

  /* ------------------------------------------------------------------ */
  /* Navegação — grid flat (temas padrão/Apple TV/OLED/...)             */
  /* ------------------------------------------------------------------ */

  function columnCount() {
    if (!gridCols) gridCols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    return gridCols;
  }

  function move(dx, dy) {
    if (apps.length === 0) return;

    if (focusOnGear) {
      if (dy > 0) { focusIndex = 0; focusTile(0); }  // ↓ do gear volta pro grid
      return;
    }

    var cols = columnCount() || 1;
    var next = focusIndex + dx + dy * cols;

    if (dy < 0 && next < 0) { // ↑ do topo vai pra engrenagem
      focusGear();
      return;
    }
    if (next < 0) next = 0;
    if (next >= apps.length) next = apps.length - 1;
    if (next !== focusIndex) focusTile(next);
  }

  /* ------------------------------------------------------------------ */
  /* Navegação — Wii: páginas 4x3 que rolam na HORIZONTAL               */
  /* ------------------------------------------------------------------ */

  function wiiMove(dx, dy) {
    if (apps.length === 0) return;

    if (focusOnGear) {
      if (dy < 0) { focusIndex = 0; focusTile(0); }  // ↑ do gear volta pro grid
      return;
    }

    var i = focusIndex;
    var page = Math.floor(i / WII_PER);
    var pos = i % WII_PER;
    var row = Math.floor(pos / WII_COLS);
    var col = pos % WII_COLS;
    var pages = Math.ceil(apps.length / WII_PER);

    if (dx < 0) { // ←
      if (col > 0) { i--; }
      else if (page > 0) { i = (page - 1) * WII_PER + row * WII_COLS + (WII_COLS - 1); }
      else { return; }
    } else if (dx > 0) { // →
      if (col < WII_COLS - 1 && i + 1 < apps.length) { i++; }
      else if (page < pages - 1) { i = Math.min((page + 1) * WII_PER + row * WII_COLS, apps.length - 1); }
      else { return; }
    } else if (dy < 0) { // ↑
      if (row > 0) { i -= WII_COLS; }
      else { return; }
    } else if (dy > 0) { // ↓
      if (row < WII_ROWS - 1) { i = Math.min(i + WII_COLS, apps.length - 1); }
      else { focusGear(); return; }  // dock embaixo: ↓ do fim vai pra engrenagem
    }

    if (i !== focusIndex) focusTile(i);
  }

  function navMove(dx, dy) {
    if (isWii()) wiiMove(dx, dy);
    else move(dx, dy);
  }

  /* ------------------------------------------------------------------ */
  /* Lançar / sair                                                      */
  /* ------------------------------------------------------------------ */

  function vetroOrigin() {
    try {
      var ip = window.webapis && webapis.network && webapis.network.getIp();
      if (ip && /^[0-9.]+$/.test(ip)) return 'http://' + ip + ':' + VETRO_PORT;
    } catch (e) { console.error('Não foi possível obter o IP da TV', e); }
    return 'http://127.0.0.1:' + VETRO_PORT;
  }

  function showLaunchStatus(message, isError) {
    clearTimeout(launchStatusTimer);
    launchStatusEl.textContent = message;
    launchStatusEl.classList.toggle('error', !!isError);
    launchStatusEl.hidden = false;
    launchStatusTimer = setTimeout(function () { launchStatusEl.hidden = true; }, isError ? 6000 : 4500);
  }

  function launch(index) {
    var app = apps[index];
    if (app && app.continueTargetId) {
      app = apps.find(function (item) { return item.id === app.continueTargetId; });
    }
    if (!app) return;
    if (!window.tizen || previewMode) {
      console.log('[demo] launch', app.name);
      return;
    }
    if (Date.now() < launchLockUntil) return;
    launchLockUntil = Date.now() + 1200;
    showLaunchStatus('Abrindo ' + app.name + '…', false);
    playLaunch(tileAt(index));
    // Root agent do Vetro abre o app (tizen.application.launch é privilégio
    // Platform, que o cert Partner não dá). A TV não completa conexões do
    // web app para seu loopback; usamos seu IP LAN via Samsung Network API.
    // no-cors deixa a resposta opaca, mas evita o preflight sem CORS.
    // Entradas de sistema (app.cmd) rodam um comando fixo pelo /exec.
    var failed = function (err) {
      console.error('launch via Vetro falhou', err);
      showLaunchStatus('Não foi possível abrir ' + app.name + '. Verifique o Vetro.', true);
      launchLockUntil = 0;
    };
    try {
      fetch(vetroOrigin() + (app.cmd ? '/exec' : '/apps/launch'), {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(app.cmd ? { cmd: app.cmd } : { appId: app.id })
      }).then(function () {
        if (app.id === 'dizen.sys.home' || app.id === 'dizen.sys.settings') return;
        lastAppId = app.id;
        try { localStorage.setItem(LAST_APP_KEY, lastAppId); }
        catch (e) { console.error('Não foi possível salvar o último app', e); }
        // A resposta do Vetro pode chegar depois de o app já ter escondido o Dizen.
        if (document.hidden) refreshContinue();
      }).catch(failed);
    } catch (e) {
      failed(e);
    }
  }

  // "Apertão" do canal ao abrir (só o tema Wii tem estilo para a classe).
  function playLaunch(tile) {
    if (!tile || reducedMotion) return;
    tile.classList.remove('launching');
    void tile.offsetWidth;
    tile.classList.add('launching');
    setTimeout(function () { tile.classList.remove('launching'); }, 600);
  }

  /*
   * Voltar/Exit NÃO fecham o Dizen: ele é a tela inicial da TV (modo "custom
   * launcher" do Vetro, tools/set-home.sh). Fechar derrubaria para a Home da
   * Samsung. Em vez disso, voltam ao começo: fecham nada (o overlay trata as
   * próprias teclas antes) e levam o foco ao primeiro canal. A saída para a
   * Home da Samsung continua no canal "Home Samsung".
   */
  function goHome() {
    saveFocus();
    if (apps.length && (focusOnGear || focusIndex !== 0)) focusTile(0);
  }

  function activate() {
    if (focusOnGear) {
      openSettings();
    } else {
      launch(focusIndex);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Configurações                                                      */
  /* ------------------------------------------------------------------ */

  function buildThemeList() {
    themeListEl.innerHTML = '';
    var themes = DizenThemes.THEMES;
    for (var i = 0; i < themes.length; i++) {
      var li = document.createElement('li');
      li.className = 'theme-item';
      li.textContent = themes[i].label;
      if (themes[i].id === currentThemeId) li.classList.add('active');
      li.dataset.index = i;
      li.addEventListener('click', function () {
        themeIndex = parseInt(this.dataset.index, 10);
        selectTheme();
      });
      themeListEl.appendChild(li);
    }
  }

  function openSettings() {
    buildThemeList();
    orderListEl.innerHTML = '';
    focusedOrderEl = null;
    overlayOpen = true;
    restartLive();
    document.body.classList.add('settings-open');
    overlay.hidden = false;

    var themes = DizenThemes.THEMES;
    themeIndex = 0;
    for (var i = 0; i < themes.length; i++) {
      if (themes[i].id === currentThemeId) { themeIndex = i; break; }
    }
    setSettingsPane('themes');
  }

  function closeSettings() {
    if (movingApp) cancelOrderMove();
    overlayOpen = false;
    document.body.classList.remove('settings-open');
    overlay.hidden = true;
    focusGear();
    restartLive();
  }

  function focusThemeItem() {
    var items = themeListEl.children;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.remove('focus');
    }
    var cur = items[themeIndex];
    if (cur) {
      cur.classList.add('focus');
      cur.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveTheme(dy) {
    var n = DizenThemes.THEMES.length;
    themeIndex += dy;
    if (themeIndex < 0) themeIndex = 0;
    if (themeIndex >= n) themeIndex = n - 1;
    focusThemeItem();
  }

  function selectTheme() {
    var theme = DizenThemes.THEMES[themeIndex];
    if (!theme) return;
    var wasWii = isWii();
    currentThemeId = theme.id;
    DizenThemes.applyTheme(theme.id);
    DizenThemes.saveTheme(theme.id);
    // Só o Wii muda a estrutura do DOM (páginas 4x3). Os demais temas são só
    // CSS escopado por html[data-theme] — trocar de tema entre eles não precisa
    // reconstruir o grid nem re-decodificar os ícones (era o que fazia a troca
    // "demorar pra carregar").
    if (wasWii !== isWii()) {
      render();
    } else {
      gridCols = 0;   // nº de colunas muda entre temas; re-lê no próximo navMove
    }
    if (currentThemeId !== 'appletv') setShelfHidden(true);
    syncAmbience();
    syncThemeTimers();
    closeSettings();
    syncMotion();
  }

  // Sem aparelhos configurados em js/local.js, a aba HDMI não tem o que trocar.
  var SETTINGS_PANES = HDMI_DEVICES.length > 1 ? ['themes', 'order', 'hdmi'] : ['themes', 'order'];
  hdmiTab.hidden = HDMI_DEVICES.length < 2;
  var PANE_HINTS = {
    themes: '←/→ seção · ↑/↓ escolher · OK selecionar · Voltar fechar',
    order: '←/→ seção · ↑/↓ escolher · OK mover · Voltar fechar',
    hdmi: '←/→ seção · ↑/↓ porta · OK trocar aparelho · Voltar fechar'
  };

  function setSettingsPane(pane) {
    if (movingApp) return;
    settingsPane = pane;
    themeListEl.hidden = pane !== 'themes';
    orderListEl.hidden = pane !== 'order';
    hdmiListEl.hidden = pane !== 'hdmi';
    themeTab.classList.toggle('active', pane === 'themes');
    orderTab.classList.toggle('active', pane === 'order');
    hdmiTab.classList.toggle('active', pane === 'hdmi');
    panelHint.textContent = PANE_HINTS[pane];
    if (pane === 'themes') focusThemeItem();
    else if (pane === 'order') {
      if (!orderListEl.children.length) buildOrderList();
      focusOrderItem();
    } else {
      buildHdmiList();
    }
  }

  function stepSettingsPane(dir) {
    var next = SETTINGS_PANES.indexOf(settingsPane) + dir;
    if (next >= 0 && next < SETTINGS_PANES.length) setSettingsPane(SETTINGS_PANES[next]);
  }

  function buildHdmiList() {
    hdmiListEl.innerHTML = '';
    for (var n = 1; n <= HDMI_PORTS; n++) {
      var li = document.createElement('li');
      li.className = 'theme-item hdmi-item';
      if (n - 1 === hdmiIndex) li.classList.add('focus');
      var port = document.createElement('span');
      port.className = 'hdmi-port';
      port.textContent = 'HDMI ' + n;
      var device = document.createElement('span');
      device.className = 'hdmi-device';
      device.textContent = hdmiDevice(n).name || 'Sem aparelho';
      li.appendChild(port);
      li.appendChild(device);
      li.dataset.index = n - 1;
      li.addEventListener('click', function () {
        hdmiIndex = parseInt(this.dataset.index, 10);
        cycleHdmiDevice();
      });
      hdmiListEl.appendChild(li);
    }
  }

  function moveHdmi(dy) {
    hdmiIndex = Math.max(0, Math.min(HDMI_PORTS - 1, hdmiIndex + dy));
    buildHdmiList();
  }

  // OK passa ao próximo aparelho da lista e já aplica no grid.
  function cycleHdmiDevice() {
    var port = hdmiIndex + 1;
    var at = HDMI_DEVICES.indexOf(hdmiDevice(port));
    hdmiChoice[port] = HDMI_DEVICES[(at + 1) % HDMI_DEVICES.length].id;
    try { localStorage.setItem(HDMI_DEVICES_KEY, JSON.stringify(hdmiChoice)); }
    catch (e) { console.error('Não foi possível salvar os aparelhos HDMI', e); }
    var entry = hdmiEntry(port);
    for (var i = 0; i < apps.length; i++) {
      if (apps[i].id === 'dizen.sys.hdmi' + port) {
        apps[i].name = entry.name;
        apps[i].icon = entry.icon;
        apps[i].fallback = entry.name.charAt(0);
      }
    }
    refreshContinue(false);     // "Continuar: HDMI 2" acompanha o novo nome
    render();
    orderListEl.innerHTML = '';  // a lista de ordem mostra nomes: refaz ao abrir
    focusedOrderEl = null;
    buildHdmiList();
  }

  function buildOrderList() {
    orderListEl.innerHTML = '';
    focusedOrderEl = null;
    for (var i = 0; i < apps.length; i++) {
      var li = document.createElement('li');
      li.className = 'theme-item order-item';
      var number = document.createElement('span');
      number.className = 'order-number';
      number.textContent = (i + 1) + '.';
      var name = document.createElement('span');
      name.className = 'order-name';
      name.textContent = apps[i].name;
      li.appendChild(number);
      li.appendChild(name);
      li.dataset.index = i;
      li.addEventListener('click', function () {
        var index = parseInt(this.dataset.index, 10);
        if (movingApp && index !== orderIndex) moveOrderTo(index);
        else { orderIndex = index; toggleOrderMove(); }
        focusOrderItem();
      });
      orderListEl.appendChild(li);
    }
  }

  function focusOrderItem() {
    var cur = orderListEl.children[orderIndex];
    if (focusedOrderEl && focusedOrderEl !== cur) {
      focusedOrderEl.classList.remove('focus', 'moving');
    }
    if (cur) {
      cur.classList.add('focus');
      cur.classList.toggle('moving', movingApp);
      cur.scrollIntoView({ block: 'nearest' });
    }
    focusedOrderEl = cur || null;
  }

  function moveOrderTo(index) {
    if (index < 0 || index >= apps.length || index === orderIndex) return;
    var oldIndex = orderIndex;
    var item = orderListEl.children[oldIndex];
    var target = orderListEl.children[index];
    orderListEl.insertBefore(item, index > oldIndex ? target.nextSibling : target);
    var app = apps.splice(orderIndex, 1)[0];
    apps.splice(index, 0, app);
    for (var i = Math.min(oldIndex, index); i <= Math.max(oldIndex, index); i++) {
      orderListEl.children[i].dataset.index = i;
      orderListEl.children[i].firstElementChild.textContent = (i + 1) + '.';
    }
    orderIndex = index;
    focusOrderItem();
  }

  function toggleOrderMove() {
    if (!apps.length) return;
    if (movingApp) {
      movingApp = false;
      orderSnapshot = null;
      saveAppOrder();
      syncTileOrder();
      panelHint.textContent = '←/→ seção · ↑/↓ escolher · OK mover · Voltar fechar';
    } else {
      orderSnapshot = apps.slice();
      movingApp = true;
      panelHint.textContent = '↑/↓ reordenar · OK salvar · Voltar cancelar';
    }
    focusOrderItem();
  }

  function cancelOrderMove() {
    if (orderSnapshot) apps = orderSnapshot;
    orderSnapshot = null;
    movingApp = false;
    buildOrderList();
    focusOrderItem();
    panelHint.textContent = '←/→ seção · ↑/↓ escolher · OK mover · Voltar fechar';
  }

  function moveOrder(dy) {
    if (!apps.length) return;
    var next = Math.max(0, Math.min(apps.length - 1, orderIndex + dy));
    if (movingApp) moveOrderTo(next);
    else { orderIndex = next; focusOrderItem(); }
  }

  /* ------------------------------------------------------------------ */
  /* Input                                                              */
  /* ------------------------------------------------------------------ */

  function handleOverlayKey(e) {
    var pane = settingsPane;
    switch (e.keyCode) {
      case 37: if (!movingApp) stepSettingsPane(-1); e.preventDefault(); break;
      case 39: if (!movingApp) stepSettingsPane(1); e.preventDefault(); break;
      case 38: case 40:
        var dy = e.keyCode === 38 ? -1 : 1;
        if (pane === 'themes') moveTheme(dy); else if (pane === 'order') moveOrder(dy); else moveHdmi(dy);
        e.preventDefault(); break;
      case 13:
        if (pane === 'themes') selectTheme(); else if (pane === 'order') toggleOrderMove(); else cycleHdmiDevice();
        e.preventDefault(); break;
      case 10009: case 10182: if (movingApp) cancelOrderMove(); else closeSettings(); e.preventDefault(); break;
    }
  }

  document.addEventListener('keydown', function (e) {
    if (ambienceBlocked) playAmbience();
    restartLive();
    if (overlayOpen) {
      handleOverlayKey(e);
      return;
    }
    switch (e.keyCode) {
      case 37: navMove(-1, 0); e.preventDefault(); break;  // ←
      case 38: navMove(0, -1); e.preventDefault(); break;  // ↑
      case 39: navMove(1, 0);  e.preventDefault(); break;  // →
      case 40: navMove(0, 1);  e.preventDefault(); break;  // ↓
      case 13: activate(); e.preventDefault(); break;      // OK
      case 10009: case 10182: goHome(); e.preventDefault(); break; // Voltar/Exit: não saem
    }
  });

  settingsBtn.addEventListener('click', function () { openSettings(); });
  themeTab.addEventListener('click', function () { setSettingsPane('themes'); });
  orderTab.addEventListener('click', function () { setSettingsPane('order'); });
  hdmiTab.addEventListener('click', function () { setSettingsPane('hdmi'); });
  document.addEventListener('click', function () {
    if (ambienceBlocked) playAmbience();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      saveFocus();
      // O tile "Continuar" muda quando se abre um app; reconstruir o grid AO VOLTAR
      // somava ~1 s de CPU à volta do Home. Escondido, o custo fica fora da tela.
      refreshContinue();
      wiiAmbience.pause();
      syncMotion();
      syncPluginTimer();
    } else {
      tickClock();
      refreshContinue();
      playAmbience();
      syncMotion();
      playEnter();
      syncPluginTimer();
    }
  });
  window.addEventListener('resize', function () { gridCols = 0; });

  /* ------------------------------------------------------------------ */

  // Exit vem para o app em vez de a plataforma fechá-lo (privilégio tv.inputdevice
  // em config.xml). Back já chega por padrão.
  try { if (window.tizen && tizen.tvinputdevice) tizen.tvinputdevice.registerKey('Exit'); }
  catch (e) { console.error('Exit não registrado', e); }

  initTheme();
  loadApps();
  syncAmbience();
  syncPluginTimer();
})();
