'use strict';
/*
 * dizen-sync — plugin do Vetro (API 1) que faz, de dentro da TV, o que o
 * tools/sync-apps.sh faz do PC: mantém launcher/js/apps.js e os ícones da cópia
 * instalada do Dizen em dia com os apps instalados, os canais e os aparelhos HDMI.
 *
 * Roda dentro do serviço Node do Vetro (Node 4.4: ES5, sem Buffer.from). Docs e
 * decisões em docs/PLUGIN-SYNC.md; instalação por tools/install-plugin.sh.
 *
 * Como fica barato o bastante para rodar toda hora:
 *   - a cada POLL_MS um ÚNICO comando root calcula uma assinatura (md5 da lista
 *     de pacotes instalados, dos caches da Samsung e do apps.js instalado):
 *     ~20 ms na TV. Assinatura igual -> não faz mais nada;
 *   - só quando ela muda o sync completo roda (catálogo do Vetro, caches,
 *     ícones novos, grava apps.js);
 *   - o launcher chama /plugins/dizen-sync/api/state ao aparecer, o que dispara
 *     uma checagem na hora e devolve a lista atual (ver syncFromPlugin em
 *     launcher/js/main.js).
 *
 * Faxina: na mesma checagem, encerra componentes da Samsung que voltam a subir
 * sozinhos e que o dono da TV não usa (TIDY_APPS, ou `tidyApps` na configuração
 * do plugin no Vetro). Não desabilita pacote: a Home da
 * Samsung abre alguns deles no boot, e o boot depende dela. Encerrar é reversível
 * (basta tirar da lista) e eles só voltam no próximo boot.
 *
 * Energia: power.js observa notificações nativas e abre o Dizen no boot e
 * ao sair do standby, sem esperar o catálogo ou reconexões do root agent após standby.
 *
 * Nunca lança exceção: erro vira `lastError` no status e nova tentativa no
 * próximo ciclo (no boot o root agent leva até ~90 s para conectar).
 */
var http = require('http');
var crypto = require('crypto');

var WGT = '/opt/usr/apps/dizenlaunc/res/wgt';
var APPS_DIR = '/opt/usr/apps';
var SOURCE_CACHE = '/opt/usr/home/owner/apps_rw/com.samsung.tv.csfs/data/.sourceCache';
var CHANNEL_DIR = '/opt/usr/home/owner/apps_rw/com.samsung.tv.fuzzy-search-engine/data';
var TVS = CHANNEL_DIR + '/TVS_pt_BR.cch';
var TVPLUS = CHANNEL_DIR + '/TVPLUS_pt_BR.cch';
var POLL_MS = 60000;        // checagem de assinatura
var RETRY_MS = 15000;       // enquanto ainda não houve um sync bem-sucedido
var PING_MIN_MS = 3000;     // o launcher não dispara checagens mais juntas que isso
var SEP = '===DIZEN-SEP===';
var powerMonitor = require('./power');
// Encerrados quando aparecem: Game Hub (painel da Home) e modo Ambiente (painel + app).
var TIDY_APPS = ['com.samsung.tv.home.game', 'com.samsung.tv.home.art', 'org.tizen.art-app'];

// --- curadoria: espelho de tools/sync-apps.sh (edite os dois) ---------------
var EXCLUDE_ID = { 'dizenlaunc.dizen': 1, 'vetrotvapp.app': 1 };
var EXCLUDE_NAME = { 'vetro': 1, 'dizen': 1, 'security center': 1, 'e-manual': 1 };
var EXCLUDE_CATEGORY = { voice: 1, ads: 1, privacy: 1, tracking: 1, support: 1, commercial: 1, hotel: 1, system: 1 };
var JUNK_RE = /dummy|service|worker|preview|companion|_bg|bg[-_]service|oobe|panel/i;
var CURATED_ICONS = { '9Ur5IzDKqV.TizenYouTube': 'youtube.svg', 'org.tizen.primevideo': 'prime-video.svg' };
var KNOWN_DEVICES = [['ps5', /playstation|ps ?5|ps ?4/i], ['switch', /switch|nintendo/i], ['steamdeck', /steam ?deck|steam/i]];
var CHANNEL_RE = /^channel_\d+:(\d+),(\d+),(\d+),\d+,[^,]*,([^,]*)/;

function slug(s) {
    return String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '') || 'app';
}
function md5(text) { return crypto.createHash('md5').update(text, 'utf8').digest('hex'); }
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Lista curada a partir do catálogo do Vetro (GET /apps).
function curate(apps) {
    var best = {}, keys = [];
    for (var i = 0; i < apps.length; i++) {
        var a = apps[i];
        if (a.component !== 'uiapp' || !a.show || a.system || a.origin !== 'installed') continue;
        var cat = a.category || '';
        if (EXCLUDE_CATEGORY[cat]) continue;
        var aid = a.appId || '';
        if (EXCLUDE_ID[aid]) continue;
        var name = String(a.name || aid).trim();
        var key = name.toLowerCase();
        if (EXCLUDE_NAME[key]) continue;
        // entre duplicados de nome: prefere quem tem ícone, categoria de app "de
        // verdade" e id sem cara de serviço (Apple TV aria-video vs aria-dummy)
        var score = (a.iconPath ? 1 : 0) + (cat === 'media' || cat === 'user' ? 1 : 0) - (JUNK_RE.test(aid) ? 2 : 0);
        if (!best[key]) keys.push(key);
        if (!best[key] || score > best[key].score) best[key] = { score: score, id: aid, name: name, iconPath: a.iconPath || '' };
    }
    keys.sort();
    return keys.map(function (k) { return best[k]; });
}

function parseChannels(text) {
    var out = [], lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
        var m = CHANNEL_RE.exec(lines[i]);
        if (m) out.push({ svcid: m[1], channel: m[2] + '.' + m[3], name: m[4] });
    }
    return out;
}

function parseHdmi(text) {
    var hdmi = {}, cache;
    try { cache = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) { return hdmi; }
    Object.keys(cache).forEach(function (key) {
        var m = /^HDMI(\d)$/.exec(key), src = cache[key];
        if (!m || !src || typeof src !== 'object') return;
        var label = src.EditName || src.DetectedName || '';
        for (var i = 0; i < KNOWN_DEVICES.length; i++) {
            if (KNOWN_DEVICES[i][1].test(label)) { hdmi[m[1]] = KNOWN_DEVICES[i][0]; break; }
        }
    });
    return hdmi;
}

module.exports = function (ctx) {
    var cfg = ctx.config.get() || {};
    var wgt = cfg.wgt || WGT;
    var base = cfg.base || 'http://127.0.0.1:8099';   // base/token: só para testar do PC
    var tvChannel = cfg.tvChannel || '13.1';          // canal da entrada "TV Digital"
    var dryRun = !!cfg.dryRun;
    var tidyApps = (Array.isArray(cfg.tidyApps) ? cfg.tidyApps : TIDY_APPS).filter(function (id) { return /^[A-Za-z0-9_.-]+$/.test(id); });

    var power = null, stopped = false;
    var timer = null, running = null, lastPing = 0, lastSig = null, lastPkgSig = null;
    var state = { rev: null, apps: [], system: {}, syncedAt: null };
    var stats = { checks: 0, syncs: 0, lastCheckAt: null, lastCheckMs: null, lastSyncMs: null, lastError: null, iconsCopied: 0, tidied: {} };

    function run(cmd, timeout) {
        return ctx.execute(cmd, timeout || 20000).then(function (r) {
            if (!r || r.timed_out) throw new Error('comando root não respondeu');
            return r;
        });
    }

    function getJson(pathname) {
        return new Promise(function (resolve, reject) {
            var m = /^http:\/\/([^:\/]+)(?::(\d+))?/.exec(base);
            var headers = cfg.token ? { Authorization: 'Bearer ' + cfg.token } : {};
            var req = http.get({ host: m[1], port: m[2] || 80, path: pathname, headers: headers }, function (res) {
                var chunks = [];
                res.on('data', function (c) { chunks.push(c); });
                res.on('end', function () {
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                    catch (e) { reject(new Error('catálogo do Vetro ilegível (HTTP ' + res.statusCode + ')')); }
                });
            });
            req.setTimeout(40000, function () { req.abort(); });
            req.on('error', reject);
        });
    }

    // Encerra os TIDY_APPS que estiverem rodando (~30 ms); imprime TIDY:<id> para cada um.
    // Vai em base64: o root agent roda o comando dentro de aspas duplas e expandiria os $.
    function tidyCommand() {
        if (dryRun || !tidyApps.length) return '';
        var re = tidyApps.map(function (id) { return id.replace(/\./g, '\\.'); }).join('|');
        var script = 'for a in $(app_launcher -S 2>/dev/null | grep -oE ' + shq('(' + re + ') ') + '); do\n' +
            'app_launcher -k "$a" >/dev/null 2>&1 && echo "TIDY:$a"\ndone\n';
        return 'echo ' + new Buffer(script, 'utf8').toString('base64') + ' | base64 -d | sh; ';
    }

    // Um comando, ~20 ms: muda quando um app é instalado/removido, quando a
    // Samsung reescreve seus caches ou quando alguém troca o apps.js instalado.
    function signature() {
        return run((power ? '(' + power.command + '); ' : '') + tidyCommand() + 'ls ' + APPS_DIR + ' | md5sum; md5sum ' + [SOURCE_CACHE, TVS, TVPLUS, wgt + '/js/apps.js'].map(shq).join(' ') + ' 2>/dev/null', 8000)
            .then(function (r) {
                var out = String(r.stdout || '').replace(/^TIDY:(\S+)\n?/gm, function (_, id) {
                    stats.tidied[id] = (stats.tidied[id] || 0) + 1;
                    return '';
                }).trim();
                if (!out) throw new Error('assinatura vazia (root agent ainda não conectou?)');
                return { all: out, pkg: out.split('\n')[0] };
            });
    }

    function fullSync(pkgChanged) {
        var t0 = Date.now(), curated, files, system = {};
        // refresh=1 só quando a lista de pacotes mudou: recoleta o registro da TV.
        return getJson('/apps' + (pkgChanged ? '?refresh=1' : '')).then(function (data) {
            curated = curate(data.apps || []);
            return run('ls ' + shq(wgt + '/icons') + '; echo ' + SEP + '; cat ' + shq(SOURCE_CACHE) + '; echo; echo ' + SEP +
                '; cat ' + shq(TVS) + '; echo; echo ' + SEP + '; cat ' + shq(TVPLUS), 20000);
        }).then(function (r) {
            var parts = String(r.stdout || '').split(SEP);
            files = {};
            parts[0].split('\n').forEach(function (f) { f = f.trim(); if (f) files[f] = true; });
            var hdmi = parseHdmi(parts[1] || '');
            var aired = parseChannels(parts[2]), plus = parseChannels(parts[3]);
            var pick = aired.filter(function (c) { return c.channel === tvChannel; })[0] || aired[0];
            if (pick) system.tv = pick;
            if (plus[0]) system.tvplus = { svcid: plus[0].svcid, name: plus[0].name };
            if (Object.keys(hdmi).length) system.hdmi = hdmi;

            // Ícones: reaproveita o que já está na pasta; copia só os que faltam.
            var copies = [];
            var list = curated.map(function (app) {
                var entry = { id: app.id, name: app.name };
                var curatedIcon = CURATED_ICONS[app.id];
                if (curatedIcon && files[curatedIcon]) { entry.icon = 'icons/' + curatedIcon; return entry; }
                if (!app.iconPath) return entry;
                var stem = slug(app.id), found = null;
                ['.png', '.jpg', '.svg', '.webp', '.gif'].forEach(function (ext) { if (!found && files[stem + ext]) found = stem + ext; });
                if (!found) {
                    var ext = (/\.(png|jpe?g|svg|webp|gif)$/i.exec(app.iconPath) || [])[0];
                    if (!ext) return entry;
                    found = stem + ext.toLowerCase().replace('jpeg', 'jpg');
                    copies.push('cat ' + shq(app.iconPath) + ' > ' + shq(wgt + '/icons/' + found));
                }
                entry.icon = 'icons/' + found;
                return entry;
            });
            var text = '/* gerado pelo plugin dizen-sync do Vetro — não edite */\nwindow.DIZEN_APPS = ' + JSON.stringify(list) +
                ';\nwindow.DIZEN_SYSTEM = ' + JSON.stringify(system) + ';\n';
            var rev = md5(text);
            text += 'window.DIZEN_REV = ' + JSON.stringify(rev) + ';\n';
            var next = { rev: rev, apps: list, system: system, syncedAt: new Date().toISOString() };
            if (dryRun) { state = next; state.text = text; state.copies = copies; return null; }

            var steps = Promise.resolve();
            copies.forEach(function (cmd) { steps = steps.then(function () { return run(cmd, 15000); }); });
            return steps.then(function () {
                stats.iconsCopied += copies.length;
                // Grava DENTRO do arquivo existente (preserva dono e rótulo SMACK), só se mudou.
                var b64 = new Buffer(text, 'utf8').toString('base64');
                var target = shq(wgt + '/js/apps.js');
                return run('printf %s ' + shq(b64) + ' | base64 -d > ' + shq(wgt + '/js/.apps.js.new') + ' && { cmp -s ' +
                    shq(wgt + '/js/.apps.js.new') + ' ' + target + ' || cat ' + shq(wgt + '/js/.apps.js.new') + ' > ' + target +
                    '; }; rm -f ' + shq(wgt + '/js/.apps.js.new'), 15000);
            }).then(function (r) {
                if (r.exit_code) throw new Error('não gravei apps.js: ' + (r.stderr || r.stdout || r.exit_code));
                state = next;
            });
        }).then(function () {
            stats.syncs++;
            stats.lastSyncMs = Date.now() - t0;
        });
    }

    // Uma checagem por vez; quem chega durante uma em andamento espera a mesma.
    function check() {
        if (running) return running;
        var t0 = Date.now();
        running = signature().then(function (sig) {
            stats.checks++;
            stats.lastCheckAt = new Date().toISOString();
            if (sig.all === lastSig && state.rev) return null;
            var pkgChanged = lastPkgSig !== null && sig.pkg !== lastPkgSig;
            return fullSync(pkgChanged).then(function () {
                // o próprio sync mexe no apps.js: reassina para não disparar de novo
                return dryRun ? sig : signature();
            }).then(function (after) { lastSig = after.all; lastPkgSig = after.pkg; });
        }).then(function () {
            stats.lastError = null;
        }, function (e) {
            stats.lastError = String(e && e.message || e);
        }).then(function () {
            stats.lastCheckMs = Date.now() - t0;
            running = null;
        });
        return running;
    }

    function schedule() {
        clearTimeout(timer);
        if (stopped) return;
        timer = setTimeout(function () {
            check().then(schedule, schedule);
        }, state.rev ? POLL_MS : RETRY_MS);
        if (timer.unref) timer.unref();
    }

    function send(res, body, code) {
        var text = JSON.stringify(body);
        res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(text);
    }

    return {
        start: function () { stopped = false; if (!dryRun && !power) power = powerMonitor(ctx); check().then(schedule, schedule); },
        stop: function () { stopped = true; clearTimeout(timer); timer = null; var old = power; power = null; return Promise.resolve(running).then(function () { if (old) return old.stop(); }); },
        status: function () {
            return { rev: state.rev, apps: state.apps.length, syncedAt: state.syncedAt, system: state.system,
                checks: stats.checks, syncs: stats.syncs, lastCheckAt: stats.lastCheckAt, lastCheckMs: stats.lastCheckMs,
                lastSyncMs: stats.lastSyncMs, iconsCopied: stats.iconsCopied, tidied: stats.tidied, power: power && power.status(), lastError: stats.lastError };
        },
        // GET /plugins/dizen-sync/api/state[?rev=<rev que o launcher já tem>]
        route: function (req, res, sub) {
            if (sub.split('?')[0] !== 'state' || req.method !== 'GET') return false;
            var known = (/[?&]rev=([0-9a-f]+)/.exec(req.url || '') || [])[1];
            var reply = function () {
                if (!state.rev) return send(res, { ready: false, error: stats.lastError }, 503);
                if (known === state.rev) return send(res, { rev: state.rev, unchanged: true });
                send(res, { rev: state.rev, apps: state.apps, system: state.system, syncedAt: state.syncedAt });
            };
            // O launcher acabou de aparecer: confere agora, não no próximo minuto.
            if (Date.now() - lastPing > PING_MIN_MS) {
                lastPing = Date.now();
                check().then(reply, reply);
            } else reply();
            return true;
        },
        // exposto só para tools/test-plugin.cjs
        _check: check, _state: function () { return state; }
    };
};
module.exports.curate = curate;
module.exports.parseChannels = parseChannels;
module.exports.parseHdmi = parseHdmi;
