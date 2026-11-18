/*
 * wii-gl.js — fundo e cartões do tema Wii desenhados por WebGL, atrás do HTML.
 *
 * Por quê: nesta TV o Chromium (M85) rasteriza por software e descarta os tiles
 * quando o app fica oculto. Ao voltar do Home ele redesenhava a tela inteira pela
 * CPU (~400–500 ms de travada no Wii). No WebGL, as listras do fundo, os canais
 * vazios e o cartão de cada tile ficam como texturas na GPU: a volta só compõe.
 * Medidas e decisões em docs/PESQUISA-WEBGL.md.
 *
 * O que fica no GL: listras (por paridade da linha, cores exatas), canais vazios
 * (o SVG do próprio CSS, rasterizado pelo Chromium) e o cartão de TODOS os tiles
 * (css/themes/assets/wii-card.png, capturado do CSS renderizado na TV com alfa
 * exato: tools/wii-gl/capture_card.py) de TODOS os tiles, sempre na caixa de layout
 * (sem a escala do foco). O resto é HTML: ícones, rótulos, a barra, e o cartão do
 * tile focado (e do que acabou de perder o foco, durante a volta da escala), que em
 * CSS fica por cima do cartão do GL e o cobre. Por isso mudar o foco não redesenha o
 * GL; ele redesenha ao rolar, na entrada, na volta e quando o grid muda.
 *
 * Medido na TV: redesenhar só o retângulo do tile a cada foco (preserveDrawingBuffer)
 * levou a tecla de ~27 para ~45 ms — o Chromium copia o quadro inteiro a cada
 * atualização do canvas. Quando o cartão em CSS encolhe abaixo de 1 (o "pulo" ao
 * perder o foco, abrir), aparece o do GL por baixo — como no CSS puro aparecia o
 * canal vazio do fundo da página no mesmo lugar.
 *
 * Ativo = html.wii-gl. Sem WebGL, ou se o contexto cair, a classe sai e o CSS
 * original volta sozinho (regras html.wii-gl em css/themes/wii.css).
 */
window.DizenWiiGL = (function () {
  'use strict';

  var W = 1920, H = 1080;
  var GHOST_W = 404, GHOST_H = 228;            // = background-size do .wii-page
  var CARD_URL = 'css/themes/assets/wii-card.png';
  var CARD_DX = -4, CARD_DY = -2;              // sprite (com sombra) em relação à caixa do tile
  var CARD_W = 388, CARD_H = 212;
  var MAX_PAGES = 8;
  var HOLD_MS = 260;                           // > transition de transform do .tile (0.22s)
  var ENTER_MS = 360;                          // = animation wii-enter

  var rootEl = document.documentElement;
  var grid = null, isWii = null;
  var cv = null, gl = null, bgProg, cardProg, L = {}, quadBuf, cardBuf;
  var ghostPx = null, cardPx = null, loading = false, failed = false, ready = false;
  var enterState = null, queued = 0;

  function active() { return ready && rootEl.classList.contains('wii-gl'); }

  // ---------------------------------------------------------------- recursos

  function rasterize(url, w, h, done) {
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      done(c);
    };
    img.onerror = function () { failed = true; console.error('wii-gl: imagem não carregou', url.slice(0, 60)); };
    img.src = url;
  }

  // O SVG dos canais vazios vem do próprio CSS: lido antes de o GL assumir
  // (com html.wii-gl a regra desliga o background-image).
  function ghostUrl() {
    var page = grid.querySelector('.wii-page');
    var m = page && /url\("(.*)"\)/.exec(getComputedStyle(page).backgroundImage || '');
    return m ? m[1] : null;
  }

  var BG_VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var BG_FS = [
    'precision highp float;',
    'uniform sampler2D ghost; uniform vec4 clip;',
    'uniform vec4 pages[' + MAX_PAGES + ']; uniform vec2 anim[' + MAX_PAGES + ']; uniform int npages;',
    'vec4 over(vec4 s, vec4 d){return s + d*(1.-s.a);}',
    'void main(){',
    '  vec2 px = vec2(floor(gl_FragCoord.x), floor(' + H + '.0 - gl_FragCoord.y));',
    // listras do html[data-theme=wii] body: 2px #f9f9f9 + 2px #f1f1f1
    '  vec4 c = mod(px.y, 4.) < 2. ? vec4(vec3(0.976470588),1.) : vec4(vec3(0.945098039),1.);',
    '  if (px.x >= clip.x && px.x < clip.z && px.y >= clip.y && px.y < clip.w) {',
    '    for (int i = 0; i < ' + MAX_PAGES + '; i++) {',
    '      if (i >= npages) break;',
    '      vec4 r = pages[i]; vec2 a = anim[i];',              // a = (escala, opacidade)
    '      vec2 ctr = (r.xy + r.zw) * .5;',
    '      vec2 q = ctr + (px + .5 - ctr) / a.x - .5;',       // desfaz a escala da página
    '      if (q.x >= r.x && q.x < r.z && q.y >= r.y && q.y < r.w) {',
    '        vec2 m = mod(floor(q + .5) - r.xy, vec2(' + GHOST_W + '.,' + GHOST_H + '.));',
    '        c = over(texture2D(ghost, (m + .5) / vec2(' + GHOST_W + '.,' + GHOST_H + '.)) * a.y, c);',
    '      }',
    '    }',
    '  }',
    '  gl_FragColor = c;',
    '}'].join('\n');
  var CARD_VS = 'attribute vec2 p; attribute vec3 t; varying vec3 v;' +
    'void main(){v=t;gl_Position=vec4(p.x/' + (W / 2) + '.-1.,1.-p.y/' + (H / 2) + '.,0.,1.);}';
  var CARD_FS = 'precision mediump float; uniform sampler2D card; varying vec3 v;' +
    'void main(){gl_FragColor=texture2D(card,v.xy)*v.z;}';

  function program(vs, fs) {
    function shader(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function texture(unit, canvas, filter) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // Cria (ou recria, depois de perder o contexto) programas, buffers e texturas.
  function setup() {
    try {
      gl = cv.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: true, preserveDrawingBuffer: false });
      if (!gl) throw new Error('sem WebGL');
      bgProg = program(BG_VS, BG_FS);
      cardProg = program(CARD_VS, CARD_FS);
      quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      cardBuf = gl.createBuffer();
      L.ghost = gl.getUniformLocation(bgProg, 'ghost');
      L.clip = gl.getUniformLocation(bgProg, 'clip');
      L.pages = gl.getUniformLocation(bgProg, 'pages');
      L.anim = gl.getUniformLocation(bgProg, 'anim');
      L.npages = gl.getUniformLocation(bgProg, 'npages');
      L.bgP = gl.getAttribLocation(bgProg, 'p');
      L.card = gl.getUniformLocation(cardProg, 'card');
      L.cP = gl.getAttribLocation(cardProg, 'p');
      L.cT = gl.getAttribLocation(cardProg, 't');
      texture(0, ghostPx, gl.NEAREST);
      texture(1, cardPx, gl.LINEAR);     // posição fracionária só durante rolagem/entrada
      gl.useProgram(bgProg); gl.uniform1i(L.ghost, 0);
      gl.useProgram(cardProg); gl.uniform1i(L.card, 1);
      gl.viewport(0, 0, W, H);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      return true;
    } catch (e) {
      console.error('wii-gl: desligado,', e && e.message || e);
      failed = true;
      return false;
    }
  }

  function start() {
    if (loading || ready || failed) return;
    var url = ghostUrl();
    if (!url) return;                       // ainda sem páginas: o render() chama de novo
    loading = true;
    rasterize(url, GHOST_W, GHOST_H, function (g) {
      ghostPx = g;
      rasterize(CARD_URL, CARD_W, CARD_H, function (c) {
        cardPx = c;
        loading = false;
        cv = document.createElement('canvas');
        cv.id = 'wii-gl';
        cv.width = W; cv.height = H;
        document.body.insertBefore(cv, document.body.firstChild);
        cv.addEventListener('webglcontextlost', function (e) {
          e.preventDefault();               // permite o restored
          rootEl.classList.remove('wii-gl');
        }, false);
        cv.addEventListener('webglcontextrestored', function () {
          if (setup()) sync();
        }, false);
        if (!setup()) return;
        ready = true;
        sync();
      });
    });
  }

  // ---------------------------------------------------------------- desenho

  function wantsGlCard(tile) {
    return !tile.classList.contains('focus') && !tile.classList.contains('launching') && !tile.dataset.glHold;
  }

  // Classe gl-card: o CSS deixa de pintar o cartão desse tile (o GL já pinta).
  function syncCard(tile) {
    if (tile && tile.classList) tile.classList.toggle('gl-card', wantsGlCard(tile));
  }

  function syncCards() {
    var tiles = grid.querySelectorAll('.tile');
    for (var i = 0; i < tiles.length; i++) syncCard(tiles[i]);
  }

  // O tile que perdeu o foco mantém o cartão em CSS enquanto a escala volta.
  function hold(tile) {
    if (!tile || !tile.classList) return;
    clearTimeout(tile._glHold);           // um timer antigo não pode soltar antes da hora
    tile.dataset.glHold = '1';
    syncCard(tile);
    tile._glHold = setTimeout(function () { delete tile.dataset.glHold; syncCard(tile); }, HOLD_MS);
  }

  function unscale(r, ctr, s) {
    return { l: ctr.x + (r.left - ctr.x) / s, t: ctr.y + (r.top - ctr.y) / s,
             r: ctr.x + (r.right - ctr.x) / s, b: ctr.y + (r.bottom - ctr.y) / s };
  }

  // Caixa do tile na tela SEM a escala dele (foco 1.05, abrir) e sem a da página
  // (entrada): centro da caixa transformada (as escalas são em torno do centro)
  // com o tamanho de layout.
  function tileBox(tile, ctr, s) {
    var r = tile.getBoundingClientRect();
    var cx = ctr.x + ((r.left + r.right) / 2 - ctr.x) / s;
    var cy = ctr.y + ((r.top + r.bottom) / 2 - ctr.y) / s;
    return { l: cx - tile.offsetWidth / 2, t: cy - tile.offsetHeight / 2 };
  }

  // Um desenho por quadro: agenda no rAF, que roda antes da pintura do mesmo quadro.
  function draw() {
    if (active() && !queued) queued = requestAnimationFrame(drawNow);
  }

  // Desenha já (use dentro de um rAF que acabou de mudar o DOM: mesmo quadro).
  function drawNow() {
    if (queued) { cancelAnimationFrame(queued); queued = 0; }
    if (!active() || document.hidden || gl.isContextLost()) return;
    // Só leituras de layout aqui (getBoundingClientRect: sob will-change o offsetParent
    // dos tiles é a página e offsetLeft engana); nenhuma escrita no DOM.
    var g = grid.getBoundingClientRect();
    var pages = grid.children, pr = new Float32Array(MAX_PAGES * 4), pa = new Float32Array(MAX_PAGES * 2);
    var n = 0, verts = [], cards = 0;
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i], s = 1, o = 1;
      if (enterState && enterState.page === page) { s = enterState.s; o = enterState.o; }
      var raw = page.getBoundingClientRect();
      var ctr = { x: (raw.left + raw.right) / 2, y: (raw.top + raw.bottom) / 2 };   // transform-origin
      var P = unscale(raw, ctr, s);
      if (P.r <= g.left || P.l >= g.right) continue;
      if (n < MAX_PAGES) { pr.set([P.l, P.t, P.r, P.b], n * 4); pa.set([s, o], n * 2); n++; }
      var tiles = page.children;
      for (var j = 0; j < tiles.length; j++) {
        var T = tileBox(tiles[j], ctr, s);
        var x0 = T.l + CARD_DX, y0 = T.t + CARD_DY;
        var ax = ctr.x + (x0 - ctr.x) * s, ay = ctr.y + (y0 - ctr.y) * s;
        var bx = ctr.x + (x0 + CARD_W - ctr.x) * s, by = ctr.y + (y0 + CARD_H - ctr.y) * s;
        verts.push(ax, ay, 0, 0, o, bx, ay, 1, 0, o, ax, by, 0, 1, o,
                   ax, by, 0, 1, o, bx, ay, 1, 0, o, bx, by, 1, 1, o);
        cards++;
      }
    }

    // fundo: listras + canais vazios
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(bgProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(L.bgP);
    gl.vertexAttribPointer(L.bgP, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(L.clip, g.left, g.top, g.right, g.bottom);
    gl.uniform4fv(L.pages, pr);
    gl.uniform2fv(L.anim, pa);
    gl.uniform1i(L.npages, n);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(L.bgP);

    // cartões, recortados pela área do grid (o overflow dele)
    if (cards) {
      gl.enable(gl.BLEND);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.round(g.left), Math.round(H - g.bottom), Math.round(g.width), Math.round(g.height));
      gl.useProgram(cardProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, cardBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(L.cP);
      gl.vertexAttribPointer(L.cP, 2, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(L.cT);
      gl.vertexAttribPointer(L.cT, 3, gl.FLOAT, false, 20, 8);
      gl.drawArrays(gl.TRIANGLES, 0, cards * 6);
      gl.disableVertexAttribArray(L.cP);
      gl.disableVertexAttribArray(L.cT);
    }
  }

  // ---------------------------------------------------------------- entrada da página

  function bezier(x1, y1, x2, y2) {
    return function (x) {
      var t = x;
      for (var k = 0; k < 8; k++) {
        var dx = 3 * x1 * t * (1 - t) * (1 - t) + 3 * x2 * t * t * (1 - t) + t * t * t - x;
        var d = 3 * x1 * (1 - t) * (1 - 3 * t) + 3 * x2 * t * (2 - 3 * t) + 3 * t * t;
        if (Math.abs(dx) < 1e-6 || !d) break;
        t -= dx / d;
      }
      return 3 * y1 * t * (1 - t) * (1 - t) + 3 * y2 * t * t * (1 - t) + t * t * t;
    };
  }
  var easeOut = bezier(0, 0, 0.58, 1);       // = ease-out da animation wii-enter

  // A animação wii-enter (opacity 0→1, scale .965→1) por JS: o mesmo valor vai para a
  // página no DOM (ícones/rótulos) e para o GL (cartões/canais) no mesmo quadro.
  // Devolve false se o GL não está ativo (aí o main.js usa a classe CSS de sempre).
  function enter(page) {
    if (!active() || !page) return false;
    var t0 = performance.now();
    function frame(now) {
      var p = Math.min(Math.max((now - t0) / ENTER_MS, 0), 1), e = easeOut(p);
      var done = p >= 1 || !active();
      enterState = done ? null : { page: page, s: 0.965 + 0.035 * e, o: e };
      page.style.opacity = done ? '' : String(e);
      page.style.transform = done ? '' : 'scale(' + enterState.s + ')';
      drawNow();
      if (!done) requestAnimationFrame(frame);
    }
    frame(t0);
    return true;
  }

  // ---------------------------------------------------------------- tema

  // Chamado quando o tema muda e depois de cada render(): liga no Wii, desliga fora dele.
  function sync() {
    if (!grid) return;
    if (!isWii()) { rootEl.classList.remove('wii-gl'); return; }
    if (!ready) { start(); return; }
    if (gl.isContextLost()) return;
    syncCards();
    rootEl.classList.add('wii-gl');
    drawNow();
  }

  function init(gridEl, isWiiFn) {
    grid = gridEl;
    isWii = isWiiFn;
    window.addEventListener('resize', draw);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) draw(); });
  }

  return { init: init, sync: sync, draw: draw, drawNow: drawNow, syncCard: syncCard,
           syncCards: syncCards, hold: hold, enter: enter, active: active };
})();
