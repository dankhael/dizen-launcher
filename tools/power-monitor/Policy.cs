using System;
// One launch per observed standby -> on transition (plus one re-assert, see below). All entry points serialized.
// Standby is 4 (screen off) and, ~17 s later, 5 (deep standby): turning on after that comes back as 5 -> 1.
class Policy {
    public Func<bool> Enabled, Claimed;
    public Func<double> Uptime;
    public Action Claim, Cancel;
    public Action<Action, int> Later;
    public Func<bool> Launch;
    int power = -1, generation;
    bool boot, pending, bootLaunched, stopped;
    public void Stop() { stopped = true; Invalidate(); }
    void Invalidate() { generation++; Cancel(); pending = false; }
    public const int WakeDelay = 150, ReassertDelay = 1500;
    static bool Standby(int state) { return state == 4 || state == 5; }
    void Request(string reason) {
        Invalidate();
        int token = generation, attempts = 0;
        bool reasserted = false;
        Action attempt = null;
        attempt = () => {
            pending = false;
            if (stopped || token != generation || power != 1 || !Enabled()) return;
            attempts++;
            if (Launch()) {
                Console.WriteLine("launch=" + (reasserted ? "reassert" : reason));
                if (reason == "boot") { Claim(); bootLaunched = true; }
                // The TV brings its last source (tv-viewer) back while it wakes; if that lands after the
                // first launch it covers the Dizen. One more launch later puts the Dizen back in front.
                else if (!reasserted) { reasserted = true; attempts = 0; pending = true; Later(attempt, ReassertDelay); }
            } else if (attempts < 3) { pending = true; Later(attempt, 1000); }
        };
        pending = true;
        Later(attempt, reason == "wake" ? WakeDelay : 0);
    }
    public void Event(string key, int value) {
        if (stopped) return;
        if (key == "boot") boot = value == 1;
        if (key == "power") {
            int previous = power;
            power = value;
            if (power != 1) Invalidate();
            if (Standby(previous) && power == 1) { Request("wake"); return; }
        }
        if (boot && power == 1 && Uptime() < 600 && !Claimed() && !pending && !bootLaunched) Request("boot");
    }
}
