/* /login/<token>: a tiny page that shows the live QQ login QR code, so the user can scan it any time. */
import type http from 'node:http';
import { loginSnapshot } from '../tools/login.js';

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ MCP 登录</title><style>
body{margin:0;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f4f6fa;color:#222;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px #0001;padding:28px 32px;text-align:center;max-width:380px;width:calc(100% - 32px)}
h1{font-size:20px;margin:0 0 6px}p{color:#666;font-size:14px;margin:6px 0}img{width:100%;max-width:320px;border-radius:8px;margin-top:12px}
.ok{color:#18a058;font-size:18px;font-weight:600}button{margin-top:10px;padding:8px 18px;border:0;border-radius:8px;background:#1677ff;color:#fff;font-size:14px;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#15171c;color:#eee}.card{background:#20232a}p{color:#aaa}}
</style></head><body><div class="card"><h1>QQ MCP 登录</h1><p id="s">正在读取状态…</p><div id="q"></div></div>
<script>
const base = location.pathname.replace(/[/]$/, '');
const s = document.getElementById('s'), q = document.getElementById('q');
let img = null, loading = false, lastImg = 0, lastRefresh = 0;
// load the QR screenshot without ever replacing an image that is still loading (each one takes a few seconds)
function loadQr(refresh) {
  if (loading) return;
  if (!img) { q.innerHTML = '<img alt="二维码加载中…"><br><button>换一张二维码</button>'; img = q.querySelector('img'); q.querySelector('button').onclick = () => loadQr(true); }
  loading = true; lastImg = Date.now(); if (refresh) lastRefresh = Date.now();
  const next = new Image();
  next.onload = () => { img.src = next.src; loading = false; };
  next.onerror = () => { loading = false; };
  next.src = base + '/qr.png?t=' + Date.now() + (refresh ? '&refresh=1' : '');
}
async function tick() {
  try {
    const j = await (await fetch(base + '/status', { cache: 'no-store' })).json();
    if (j.logged_in) { s.innerHTML = '<span class="ok">✓ 已登录 ' + (j.nickname || '') + '（' + j.user_id + '）</span>'; q.innerHTML = ''; img = null; return; }
    s.textContent = '用手机 QQ「扫一扫」扫码，并在手机上确认登录';
    if (!img) loadQr(true); else if (Date.now() - lastImg > 15000) loadQr(Date.now() - lastRefresh > 60000); // QR codes expire after ~2 min
  } catch (e) { s.textContent = '连接失败，稍后自动重试'; }
}
tick(); setInterval(tick, 4000);
</script></body></html>`;

export async function loginPages(sub: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  const refresh = url.searchParams.get('refresh') === '1';
  if (sub === '/' || sub === '') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(PAGE); return true; }
  if (sub === '/status') {
    const { status } = await loginSnapshot(false);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(status)); return true;
  }
  if (sub === '/qr.png') {
    const { png } = await loginSnapshot(refresh);
    if (!png) { res.writeHead(204); res.end(); return true; }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(png); return true;
  }
  return false;
}
