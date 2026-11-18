// Read-only vconf subscriptions. GLib blocks while idle; no polling or rendering.
using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Diagnostics;
using System.Text.Json;
using System.Threading;
class Program {
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate void Changed(IntPtr node, IntPtr data);
    [DllImport("libvconf.so.0", CallingConvention = CallingConvention.Cdecl)]
    static extern int vconf_notify_key_changed(string key, Changed callback, IntPtr data);
    [DllImport("libvconf.so.0", CallingConvention = CallingConvention.Cdecl)]
    static extern int vconf_get_int(string key, out int value);
    [DllImport("libvconf.so.0", CallingConvention = CallingConvention.Cdecl)]
    static extern int vconf_keynode_get_int(IntPtr node);
    [DllImport("libglib-2.0.so.0", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr g_main_loop_new(IntPtr context, int running);
    [DllImport("libglib-2.0.so.0", CallingConvention = CallingConvention.Cdecl)]
    static extern void g_main_loop_run(IntPtr loop);
    static readonly Changed Power = (node, data) => Emit("power", vconf_keynode_get_int(node));
    static readonly Changed Boot = (node, data) => Emit("boot", vconf_keynode_get_int(node));
    static readonly object Gate = new object();
    static Policy policy;
    static Timer timer;
    static void Emit(string key, int value) {
        lock (Gate) {
            Console.WriteLine(DateTime.UtcNow.ToString("o") + " " + key + "=" + value);
            if (policy != null) policy.Event(key, value);
            Console.Out.Flush();
        }
    }
    static bool Enabled() {
        try {
            using (var doc = JsonDocument.Parse(File.ReadAllText("/opt/usr/home/owner/share/vetro-dock.json")))
                return doc.RootElement.GetProperty("customApp").GetString() == "dizenlaunc.dizen";
        } catch { return false; }
    }
    static bool Launch() {
        try {
            using (var proc = Process.Start(new ProcessStartInfo("/usr/bin/app_launcher", "-s dizenlaunc.dizen") { UseShellExecute = false })) {
                if (!proc.WaitForExit(5000)) { proc.Kill(); Console.WriteLine("launch-timeout"); return false; }
                return proc.ExitCode == 0;
            }
        } catch (Exception e) { Console.WriteLine("launch-error=" + e.Message); return false; }
    }
    static int Main(string[] args) {
        if (args.Length > 0 && args[0] == "--test") return PolicyTests.Run();
        policy = new Policy {
            Enabled = Enabled,
            Claimed = () => File.Exists("/tmp/dizen-power-boot"),
            Claim = () => File.WriteAllText("/tmp/dizen-power-boot", "1"),
            Uptime = () => double.Parse(File.ReadAllText("/proc/uptime").Split(' ')[0], System.Globalization.CultureInfo.InvariantCulture),
            Cancel = () => { if (timer != null) timer.Dispose(); timer = null; },
            Later = (action, ms) => { timer = new Timer(_ => { lock (Gate) action(); }, null, ms, Timeout.Infinite); },
            Launch = Launch
        };
        const string power = "memory/sysman/power_state", boot = "memory/system/boot_done";
        if (vconf_notify_key_changed(power, Power, IntPtr.Zero) != 0 ||
            vconf_notify_key_changed(boot, Boot, IntPtr.Zero) != 0) return 1;
        int value;
        if (vconf_get_int(power, out value) == 0) Emit("power", value);
        if (vconf_get_int(boot, out value) == 0) Emit("boot", value);
        g_main_loop_run(g_main_loop_new(IntPtr.Zero, 0));
        return 0;
    }
}
