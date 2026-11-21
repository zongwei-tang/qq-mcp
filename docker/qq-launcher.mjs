// Loaded with `node --import` into SnowLuma. The process that injects into QQ uses ptrace, and with
// kernel.yama.ptrace_scope=1 (the default on most hosts, and not changeable on PaaS like Railway) a process
// may only trace its own descendants. So QQ is started here, as a child of SnowLuma's runtime process.
import { execFileSync, spawn } from 'node:child_process';

const QQ = '/opt/QQ/qq';
const ARGS = ['--no-sandbox', '--disable-gpu'];

// SnowLuma's outer process is an updater/supervisor; the runtime (injector) child has SNOWLUMA_UPDATE_ROOT.
if (process.env.SNOWLUMA_UPDATE_ROOT && !process.env.QQ_LAUNCHER_DISABLED) {
  // a QQ left over from a previous runtime cannot be injected by us: stop it
  try { execFileSync('pkill', ['-TERM', '-f', `^${QQ} ${ARGS.join(' ')}$`]); } catch { /* none running */ }
  let child;
  let stopping = false;
  const start = () => {
    child = spawn(QQ, ARGS, { stdio: 'ignore', env: process.env, cwd: process.env.HOME || '/app' });
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
