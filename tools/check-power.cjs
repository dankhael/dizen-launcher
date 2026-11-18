// Run the tests inside the same assembly deployed to the TV.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dizen-power-test-'));
try {
  const src = path.join(__dirname, '../plugin/dizen-sync');
  fs.writeFileSync(path.join(dir, 'DizenPower.dll'), Buffer.from(fs.readFileSync(path.join(src, 'DizenPower.b64'), 'utf8'), 'base64'));
  fs.copyFileSync(path.join(src, 'DizenPower.runtimeconfig.json'), path.join(dir, 'DizenPower.runtimeconfig.json'));
  const r = spawnSync(process.env.DOTNET || 'dotnet', [path.join(dir, 'DizenPower.dll'), '--test'], {
    stdio: 'inherit', env: { ...process.env, DOTNET_ROLL_FORWARD: 'Major' }
  });
  if (r.error) console.error(r.error.message);
  process.exitCode = r.status == null ? 1 : r.status;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
