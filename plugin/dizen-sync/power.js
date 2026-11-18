'use strict';
// A separate systemd unit avoids inheriting the Vetro app's launch environment
// and survives sdbd/root-agent reconnects. Only supervision uses ctx.execute.
var fs = require('fs'), path = require('path');
function quote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
module.exports = function (ctx) {
    var dll = path.join(ctx.dir, 'DizenPower.dll');
    fs.writeFileSync(dll, new Buffer(fs.readFileSync(path.join(ctx.dir, 'DizenPower.b64'), 'utf8'), 'base64'));
    var log = path.join(ctx.dir, 'power.log'), err = path.join(ctx.dir, 'power.err');
    [log, err].forEach(function (file) { fs.closeSync(fs.openSync(file, 'a')); if (fs.statSync(file).size > 65536) fs.truncateSync(file, 0); });
    var command = 'systemctl is-active --quiet dizen-power.service || systemd-run --unit=dizen-power --collect ' +
        '-p User=owner -p Restart=on-failure -p RestartSec=10 -p TimeoutStopSec=2 ' +
        '-p ' + quote('StandardOutput=append:' + log) + ' -p ' + quote('StandardError=append:' + err) + ' ' +
        '/usr/bin/dotnet ' + quote(dll) + ' >/dev/null 2>&1';
    return {
        command: command,
        stop: function () { return ctx.execute('systemctl stop dizen-power.service', 5000); },
        status: function () {
            function tail(file) {
                try {
                    var fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
                    try { var b = new Buffer(Math.min(size, 2000)); fs.readSync(fd, b, 0, b.length, Math.max(0, size - b.length)); return b.toString(); }
                    finally { fs.closeSync(fd); }
                } catch (_) { return null; }
            }
            return { events: tail(log), error: tail(err) };
        }
    };
};
