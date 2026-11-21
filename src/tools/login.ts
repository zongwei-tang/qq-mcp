/* Logging in: the real QQ client runs on a virtual display; these tools look at it and click/type on it. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { settings } from '../config.js';
import { onebot } from '../onebot.js';
import { defineTool, s } from './registry.js';

const run = promisify(execFile);
const env = () => ({ ...process.env, DISPLAY: settings.display });

export interface Geo { x: number; y: number; w: number; h: number }

/** Geometry of the biggest visible QQ window (the login window or main window). */
export async function qqWindow(): Promise<Geo | undefined> {
  try {
    const { stdout } = await run('xdotool', ['search', '--onlyvisible', '--class', 'qq'], { env: env() });
    let best: Geo | undefined;
    for (const id of stdout.split(/\s+/).filter(Boolean)) {
      const g = await run('xdotool', ['getwindowgeometry', '--shell', id], { env: env() }).then((r) => r.stdout).catch(() => '');
      const v = Object.fromEntries(g.split('\n').filter(Boolean).map((l) => l.split('=')));
      const geo = { x: +v.X, y: +v.Y, w: +v.WIDTH, h: +v.HEIGHT };
      if (geo.w > 100 && geo.h > 100 && (!best || geo.w * geo.h > best.w * best.h)) best = geo;
    }
    return best;
  } catch { return undefined; }
}

async function screenSize(): Promise<{ w: number; h: number }> {
  try {
    const { stdout } = await run('xdotool', ['getdisplaygeometry'], { env: env() });
    const [w, h] = stdout.trim().split(/\s+/).map(Number);
    if (w && h) return { w, h };
  } catch { /* fall through */ }
  return { w: 1920, h: 1080 };
}

export async function screenshot(region?: Geo): Promise<{ data: string; mimeType: string; region: Geo }> {
  const scr = await screenSize();
  const r = region ?? { x: 0, y: 0, w: scr.w, h: scr.h };
  // clamp to the screen
  r.x = Math.max(0, r.x); r.y = Math.max(0, r.y);
  r.w = Math.min(r.w, scr.w - r.x); r.h = Math.min(r.h, scr.h - r.y);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qqshot-'));
  const out = path.join(dir, 's.png');
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', `${r.w}x${r.h}`, '-i', `${settings.display}+${r.x},${r.y}`, '-frames:v', '1', out], { env: env() });
    return { data: (await fs.promises.readFile(out)).toString('base64'), mimeType: 'image/png', region: r };
  } finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** PIDs of QQ main processes (not Electron helpers). */
export async function qqPids(): Promise<number[]> {
  try { const { stdout } = await run('pgrep', ['-f', '^/opt/QQ/qq( --no-sandbox| --disable-gpu)*$']); return stdout.split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
}
export const qqRunning = async () => (await qqPids()).length > 0;

export async function status() {
  try {
    await onebot.ready(3000);
    const me = await onebot.call<any>('get_login_info', {}, 8000);
    if (me?.user_id) return { logged_in: true, user_id: me.user_id, nickname: me.nickname };
  } catch { /* not ready */ }
  return { logged_in: false, qq_client_running: await qqRunning(), onebot: settings.onebotWs, onebot_error: onebot.lastError || undefined };
}

/** Click the "刷新" button of an expired QR code (harmless on a live QR). Only on the small login window. */
async function refreshQr(win: Geo) {
  let x: number, y: number;
  if (win.w <= 420 && win.h <= 560) { x = win.x + Math.round(win.w / 2); y = win.y + Math.round(win.h * 0.61); } // small login window: QR / 刷新 in the middle
  else if (win.w >= 560 && win.w <= 760 && win.h >= 380 && win.h <= 480) { x = win.x + Math.round(win.w * 0.79); y = win.y + Math.round(win.h * 0.538); } // wide 账密+扫码 window: QR on the right
  else return; // not a login window
  await run('xdotool', ['mousemove', String(x), String(y), 'click', '1'], { env: env() }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}

/** For the /login web page: current status, plus a PNG of the login window when not logged in. */
export async function loginSnapshot(refresh: boolean): Promise<{ status: any; png?: Buffer }> {
  const st = await status();
  if (st.logged_in) return { status: st };
  const win = await qqWindow();
  if (!win) return { status: st };
  if (refresh) await refreshQr(win);
  const shot = await screenshot(await qqWindow() ?? win);
  return { status: st, png: Buffer.from(shot.data, 'base64') };
}

export function registerLoginTools() {
  defineTool({
    name: 'qq_watchdog', category: 'login', readOnly: true,
    description: 'State of the login watchdog that keeps QQ logged in automatically (re-clicks 登录 for the remembered account, dismisses 下线 pop-ups, restarts a stuck client, notifies when a QR scan is really needed). check_now=true runs a check immediately.',
    inputSchema: s.obj({ check_now: s.bool('Run one check now', { default: false }) }),
    handler: async ({ check_now = false }) => {
      const { watchdogState, checkOnce, loginPageUrl } = await import('../watchdog.js');
      if (check_now) await checkOnce();
      return { ...watchdogState, notify_configured: !!process.env.NOTIFY_WEBHOOK, login_page: loginPageUrl() ? 'set (see /login/<token>)' : 'unknown' };
    },
  });

  defineTool({
    name: 'qq_login_status', category: 'login', readOnly: true,
    description: 'Is QQ logged in and connected? Returns the account if so.',
    inputSchema: s.obj({}),
    handler: status,
  });

  defineTool({
    name: 'qq_login', category: 'login', readOnly: true,
    description: 'Log in to QQ. If not logged in, returns a screenshot of the QQ login window: show the QR code to the user and ask them to scan it with the QQ phone app (扫一扫) and confirm on the phone. If the window shows a "登录"/"进入QQ" button for a remembered account instead, click it with qq_click. Call qq_login_status afterwards (or wait=true here).',
    inputSchema: s.obj({ wait: s.bool('After showing the screen, wait up to 120s for the login to complete', { default: false }) }),
    handler: async ({ wait = false }) => {
      const st = await status();
      if (st.logged_in) return { ...st, message: 'Already logged in.' };
      if (wait) {
        for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 3000)); const s2 = await status(); if (s2.logged_in) return { ...s2, message: 'Logged in.' }; }
      }
      const win = await qqWindow();
      if (!win) {
        return { ...st, message: (await qqRunning()) ? 'QQ is starting but no window is visible yet; call qq_login again in a few seconds (or qq_screenshot).' : 'The QQ client is not running. Call qq_restart_client.' };
      }
      await refreshQr(win); // always hand out a fresh QR code
      const shot = await screenshot(await qqWindow() ?? win);
      return { __image: shot, text: `Not logged in yet. This is the QQ login window (screen offset ${win.x},${win.y}, size ${win.w}x${win.h}). Ask the user to scan the QR code with the QQ phone app, then call qq_login with wait=true. If the QR code has expired, click its refresh area with qq_click (coordinates are relative to this image).` };
    },
  });

  defineTool({
    name: 'qq_screenshot', category: 'login', readOnly: true,
    description: 'Screenshot of the virtual display the QQ client runs on (the QQ window by default, or the full screen). Use it to see dialogs such as login prompts, security checks or update notices.',
    inputSchema: s.obj({ full_screen: s.bool('Capture the whole display instead of just the QQ window', { default: false }) }),
    handler: async ({ full_screen = false }) => {
      const win = full_screen ? undefined : await qqWindow();
      const shot = await screenshot(win);
      return { __image: shot, text: win ? `QQ window at screen offset ${win.x},${win.y} (${win.w}x${win.h}). qq_click coordinates are relative to this image.` : `Full screen ${shot.region.w}x${shot.region.h}. Use qq_click with relative_to_window=false.` };
    },
  });

  defineTool({
    name: 'qq_click', category: 'login',
    description: 'Click on the QQ client window (coordinates as seen in the last qq_screenshot / qq_login image). Returns a fresh screenshot.',
    inputSchema: s.obj({ x: s.int('X in the screenshot'), y: s.int('Y in the screenshot'), relative_to_window: s.bool('Coordinates are relative to the QQ window screenshot (default) or the full screen', { default: true }), double: s.bool('Double-click', { default: false }), button: s.enum(['left', 'right', 'middle'], 'Mouse button', { default: 'left' }) }, ['x', 'y']),
    handler: async ({ x, y, relative_to_window = true, double = false, button = 'left' }) => {
      const win = relative_to_window ? await qqWindow() : undefined;
      const ax = x + (win?.x ?? 0); const ay = y + (win?.y ?? 0);
      const b = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
      await run('xdotool', ['mousemove', String(ax), String(ay), 'click', ...(double ? ['--repeat', '2'] : []), b], { env: env() });
      await new Promise((r) => setTimeout(r, 1200));
      const w2 = relative_to_window ? await qqWindow() : undefined;
      return { __image: await screenshot(w2), text: `Clicked at screen ${ax},${ay}.` };
    },
  });

  defineTool({
    name: 'qq_type', category: 'login',
    description: 'Type text or press keys in the focused QQ window (e.g. a verification code). keys uses xdotool names: "Return", "Tab", "ctrl+a", "BackSpace", "Escape".',
    inputSchema: s.obj({ text: s.str('Text to type'), keys: s.arr({ type: 'string' }, 'Keys to press after the text') }),
    handler: async ({ text, keys }) => {
      if (text) await run('xdotool', ['type', '--delay', '40', String(text)], { env: env() });
      for (const k of keys ?? []) await run('xdotool', ['key', String(k)], { env: env() });
      await new Promise((r) => setTimeout(r, 800));
      return { __image: await screenshot(await qqWindow()), text: 'Done.' };
    },
  });

  defineTool({
    name: 'qq_restart_client', category: 'login', destructive: true,
    description: 'Restart the QQ desktop client (use when it is stuck, crashed, or to get a fresh login QR code). Messages cannot be sent for ~20s while it restarts.',
    inputSchema: s.obj({}),
    handler: async () => {
      if (settings.restartCmd) {
        const [cmd, ...args] = settings.restartCmd.split(/\s+/);
        const { stdout, stderr } = await run(cmd, args).catch((e) => ({ stdout: '', stderr: String(e.message) }));
        return { restarted: !stderr, output: (stdout + stderr).trim().slice(0, 500), next: 'Wait ~15s, then call qq_login_status / qq_login.' };
      }
      const pids = await qqPids();
      if (!pids.length) return { restarted: false, message: 'QQ is not running; the launcher should start it within a few seconds. Call qq_login again shortly.' };
      for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
      return { restarted: true, stopped_pids: pids, next: 'QQ restarts automatically in a few seconds. Wait ~15s, then call qq_login_status / qq_login.' };
    },
  });
}
