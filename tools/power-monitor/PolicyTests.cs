using System;
class PolicyTests {
    class Rig {
        public Policy Policy;
        public Action Job;
        public int Launches;
        public bool Home = true, Fail, Claimed;
        public Rig(int uptime = 900) {
            Policy = new Policy {
                Uptime = () => uptime, Enabled = () => Home, Claimed = () => Claimed,
                Claim = () => Claimed = true, Cancel = () => Job = null,
                Later = (fn, delay) => Job = fn,
                Launch = () => { Launches++; return !Fail; }
            };
        }
        public void Fire() { var fn = Job; Job = null; if (fn != null) fn(); }
        public void Event(string key, int value) { Policy.Event(key, value); }
        public void Expect(int count) { if (Launches != count) throw new Exception("Expected " + count + " launches, got " + Launches); }
    }
    public static int Run() {
        var r = new Rig(); r.Event("power", 1); r.Event("boot", 1); r.Fire(); r.Expect(0);
        // Replay of the physical remote trace: on -> standby -> on (launch + one re-assert).
        r.Event("power", 4); r.Event("power", 1); r.Fire(); r.Expect(1); r.Fire(); r.Expect(2); r.Fire(); r.Expect(2);
        r.Event("power", 1); r.Fire(); r.Expect(2);
        r.Event("power", 4); r.Event("power", 1); r.Home = false; r.Fire(); r.Expect(2);
        // Deep standby (log of 2026-11-16): 4 -> 5 after ~17 s, then 5 -> 1 when turned on.
        r = new Rig(); r.Event("power", 1); r.Event("power", 4); r.Event("power", 5); r.Event("power", 1);
        r.Fire(); r.Expect(1); r.Fire(); r.Expect(2);
        // Turning off between the launch and the re-assert cancels the re-assert.
        r = new Rig(); r.Event("power", 5); r.Event("power", 1); r.Fire(); r.Expect(1); r.Event("power", 4); r.Fire(); r.Expect(1);
        r = new Rig(); r.Event("power", 4); r.Event("power", 1); r.Event("power", 4); r.Fire(); r.Expect(0);
        r = new Rig(100); r.Event("power", 1); r.Event("boot", 0); r.Fire(); r.Expect(0);
        r.Event("boot", 1); r.Fire(); r.Expect(1); r.Event("boot", 1); r.Fire(); r.Expect(1);
        r = new Rig(100); r.Claimed = true; r.Event("power", 1); r.Event("boot", 1); r.Fire(); r.Expect(0);
        r = new Rig(); r.Fail = true; r.Event("power", 4); r.Event("power", 1);
        for (int i = 0; i < 8; i++) r.Fire(); r.Expect(3);
        r = new Rig(); r.Event("power", 6); r.Event("power", 1); r.Fire(); r.Expect(0);
        r = new Rig(); r.Event("power", 4); r.Event("power", 1); r.Policy.Stop(); r.Fire(); r.Expect(0);
        r = new Rig(); r.Event("power", 2); r.Event("power", 1); r.Fire(); r.Expect(0);
        Console.WriteLine("PASS: wake trace (4 and 5), re-assert, duplicate events, Home disabled, cancellation, boot readiness/marker, bounded retries, stop, unknown state");
        return 0;
    }
}
