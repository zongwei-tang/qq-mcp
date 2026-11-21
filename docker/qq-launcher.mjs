// Loaded with `node --import` into SnowLuma. The process that injects into QQ uses ptrace, and with
// kernel.yama.ptrace_scope=1 (the default on most hosts, and not changeable on PaaS like Railway) a process
// may only trace its own descendants. So QQ is started here, as a child of SnowLuma's runtime process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const QQ = '/opt/QQ/qq';
const ARGS = ['--no-sandbox', '--disable-gpu'];

// SnowLuma's outer process is an updater/supervisor; the runtime (injector) child has SNOWLUMA_UPDATE_ROOT.
// The runtime later forks more node processes (same env, same --import): only the first one may launch QQ.
const LOCK = '/tmp/qq-launcher.pid';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function takeLock() {
  try { const owner = Number(fs.readFileSync(LOCK, 'utf8')); if (owner && owner !== process.pid && alive(owner)) return false; } catch { /* no lock */ }
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}
if (process.env.SNOWLUMA_UPDATE_ROOT && !process.env.QQ_LAUNCHER_ACTIVE && !process.env.QQ_LAUNCHER_DISABLED && takeLock()) {
  process.env.QQ_LAUNCHER_ACTIVE = String(process.pid); // inherited by every process forked from here
  let child;
  let stopping = false;
  const start = () => {
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    child = spawn(QQ, ARGS, { stdio: 'ignore', env, cwd: process.env.HOME || '/app' });
    console.log(`[qq-launcher] QQ started (pid ${child.pid})`);
    child.on('exit', (code, sig) => {
      if (stopping) return;
      console.log(`[qq-launcher] QQ exited (code ${code}, signal ${sig}); restarting in 3s`);
      setTimeout(start, 3000);
    });
  };
  setTimeout(start, 500);
  const stop = () => { stopping = true; try { child?.kill('SIGTERM'); } catch { /* gone */ } };
  process.on('exit', stop);
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(s, () => { stop(); process.exit(0); });
}
