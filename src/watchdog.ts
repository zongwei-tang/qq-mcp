/* Login watchdog: keeps the server-side QQ logged in without anyone touching it.
 *
 * Every QQ_WATCHDOG_INTERVAL seconds:
 *  - online → nothing to do.
 *  - login window with the remembered account's blue "登录" button → click it (no phone needed).
 *  - "登录失效 / 下线通知" style pop-ups → dismiss them (Return), then the above applies.
 *  - QQ's main window is up but the OneBot link has been dead for a while → restart QQ (自动登录 brings it back).
 *  - QQ not running → the launcher restarts it; nothing to do here.
 *  - only a QR code left (the session really expired) → notify once via NOTIFY_WEBHOOK with the login-page link.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { settings } from './config.js';
import { qqPids, status, type Geo } from './tools/login.js';

const run = promisify(execFile);
const env = () => ({ ...process.env, DISPLAY: settings.display });
const now = () => new Date().toISOString();

export const watchdogState = {
  enabled: false,
  lastCheck: '',
  lastOnline: '',
  offlineSince: '',
  state: 'unknown' as string,
  actions: [] as { at: string; action: string }[],
  notifiedAt: '',
};

function log(action: string) {
  watchdogState.actions.push({ at: now(), action });
  if (watchdogState.actions.length > 50) watchdogState.actions.shift();
  console.log(`[watchdog] ${action}`);
}

interface Win extends Geo { id: string }

async function qqWindows(): Promise<Win[]> {
  try {
    const { stdout } = await run('xdotool', ['search', '--onlyvisible', '--class', 'qq'], { env: env() });
    const out: Win[] = [];
    for (const id of stdout.split(/\s+/).filter(Boolean)) {
      const g = await run('xdotool', ['getwindowgeometry', '--shell', id], { env: env() }).then((r) => r.stdout).catch(() => '');
      const v = Object.fromEntries(g.split('\n').filter(Boolean).map((l) => l.split('=')));
      const w = { id, x: +v.X, y: +v.Y, w: +v.WIDTH, h: +v.HEIGHT };
      if (w.w > 60 && w.h > 60) out.push(w);
    }
    return out;
  } catch { return []; }
}

/** RGB of one screen pixel. */
async function pixel(x: number, y: number): Promise<[number, number, number] | undefined> {
  try {
    const { stdout } = await run('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-video_size', '1x1', '-i', `${settings.display}+${x},${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { env: env(), encoding: 'buffer' as any, maxBuffer: 1024 });
    const b = stdout as unknown as Buffer;
    return b.length >= 3 ? [b[0], b[1], b[2]] : undefined;
  } catch { return undefined; }
}

const isLoginWindow = (w: Geo) => w.w >= 280 && w.w <= 420 && w.h >= 400 && w.h <= 560;
const isQqBlue = (p?: number[]) => !!p && p[0] < 40 && p[1] > 120 && p[1] < 190 && p[2] > 220;

/** The remembered-account screen has a wide blue "登录" button at ~71% of the window height. */
async function quickLoginButton(w: Geo): Promise<{ x: number; y: number } | undefined> {
  const y = w.y + Math.round(w.h * 0.713);
  const xs = [0.19, 0.5, 0.81].map((f) => w.x + Math.round(w.w * f));
  const px = await Promise.all(xs.map((x) => pixel(x, y)));
  return px.every(isQqBlue) ? { x: xs[1], y } : undefined;
}

async function click(x: number, y: number) {
  await run('xdotool', ['mousemove', String(x), String(y), 'click', '1'], { env: env() });
}

async function notify(text: string) {
  const url = process.env.NOTIFY_WEBHOOK;
  if (!url) { log(`needs a QR scan, but NOTIFY_WEBHOOK is not set: ${text}`); return; }
  try {
    let r: Response;
    if (url.includes('{text}')) r = await fetch(url.replace('{text}', encodeURIComponent(text)));
    else if (/discord(app)?\.com\/api\/webhooks/.test(url)) r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) });
    else r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'QQ MCP', text, content: text, msg: text, desp: text }) });
    log(`notified (HTTP ${r.status})`);
  } catch (e) { log(`notify failed: ${(e as Error).message}`); }
}

export function loginPageUrl(): string {
  const base = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  const token = process.env.MCP_AUTH_TOKEN || '';
  return base && token ? `${base.replace(/\/$/, '')}/login/${token}` : '';
}

let mainUpSince = 0;
let lastRestart = 0;
let qrSince = 0;

export async function checkOnce(): Promise<string> {
  watchdogState.lastCheck = now();
  const st: any = await status().catch(() => ({ logged_in: false }));
  if (st.logged_in) {
    watchdogState.lastOnline = now();
    if (watchdogState.offlineSince) log(`back online as ${st.nickname ?? st.user_id}`);
    watchdogState.offlineSince = ''; watchdogState.notifiedAt = ''; mainUpSince = 0; qrSince = 0;
    return (watchdogState.state = 'online');
  }
  if (!watchdogState.offlineSince) watchdogState.offlineSince = now();
  if (!(await qqPids()).length) { mainUpSince = 0; return (watchdogState.state = 'qq_starting'); }

  const wins = await qqWindows();
  if (!wins.length) return (watchdogState.state = 'qq_no_window');
  const login = wins.find(isLoginWindow);
  const main = wins.filter((w) => !isLoginWindow(w)).sort((a, b) => b.w * b.h - a.w * a.h)[0];

  // pop-ups (kicked / session expired notices) sit on top of the login or main window: dismiss them
  const dialogs = wins.filter((w) => w !== main && !isLoginWindow(w) && w.w < 520 && w.h < 400);
  for (const d of dialogs) {
    await run('xdotool', ['windowactivate', '--sync', d.id, 'key', 'Return'], { env: env() }).catch(() => {});
    log(`dismissed a QQ pop-up (${d.w}x${d.h})`);
  }
  if (dialogs.length) return (watchdogState.state = 'dismissed_popup');

  if (login) {
    mainUpSince = 0;
    const btn = await quickLoginButton(login);
    if (btn) {
      await click(btn.x, btn.y);
      log('clicked 登录 for the remembered account');
      return (watchdogState.state = 'quick_login_clicked');
    }
    // only a QR code: a human has to scan it
    if (!qrSince) qrSince = Date.now();
    const graceMs = Number(process.env.QQ_NOTIFY_AFTER_SECONDS || 120) * 1000;
    if (!watchdogState.notifiedAt && Date.now() - qrSince > graceMs) {
      watchdogState.notifiedAt = now();
      const link = loginPageUrl();
      await notify(`QQ MCP 掉线了，需要扫码重新登录。${link ? `打开 ${link} ，用手机 QQ 扫一扫。` : '调用 qq_login 获取二维码。'}`);
    }
    return (watchdogState.state = 'needs_qr_scan');
  }

  // main window but no OneBot: injection/connection broke; a restart re-logs in via 自动登录
  if (main) {
    if (!mainUpSince) mainUpSince = Date.now();
    const stuckMs = Number(process.env.QQ_RESTART_AFTER_SECONDS || 180) * 1000;
    if (Date.now() - mainUpSince > stuckMs && Date.now() - lastRestart > 10 * 60_000) {
      lastRestart = Date.now(); mainUpSince = 0;
      for (const p of await qqPids()) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
      log('QQ looked logged in but the API was down for minutes: restarted QQ');
      return (watchdogState.state = 'restarted_qq');
    }
    return (watchdogState.state = 'main_window_no_api');
  }
  return (watchdogState.state = 'unknown_window');
}

export function startWatchdog() {
  const sec = Number(process.env.QQ_WATCHDOG_INTERVAL || 30);
  if (!sec || /^(0|false|off)$/i.test(process.env.QQ_WATCHDOG || '')) return;
  watchdogState.enabled = true;
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await checkOnce(); } catch (e) { log(`check failed: ${(e as Error).message}`); } finally { busy = false; }
  };
  setTimeout(tick, 20_000).unref();
  setInterval(tick, sec * 1000).unref();
  console.log(`[watchdog] login watchdog every ${sec}s`);
}
