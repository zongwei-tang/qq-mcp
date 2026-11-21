/* Minimal QQ 空间 web client: cookies come from the logged-in QQ client (get_cookies), requests go through h5.qzone.qq.com. */
import { onebot } from '../onebot.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

let cache: { at: number; cookie: string; uin: string; gtk: string } | undefined;

export function gtk(skey: string): string {
  let h = 5381;
  for (let i = 0; i < skey.length; i++) h += (h << 5) + skey.charCodeAt(i);
  return String(h & 0x7fffffff);
}

/** Use a cookie string directly (tests / probing). */
export function setQzoneCookie(cookie: string) {
  const jar = Object.fromEntries(cookie.split(/;\s*/).filter(Boolean).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  cache = { at: Date.now() + 1e12, cookie, uin: String(jar.uin || jar.p_uin).replace(/^o0*/, ''), gtk: gtk(jar.p_skey || jar.skey) };
}

export async function qzoneAuth(refresh = false) {
  if (!refresh && cache && Date.now() - cache.at < 20 * 60_000) return cache;
  const r = await onebot.call<{ cookies: string }>('get_cookies', { domain: 'qzone.qq.com' });
  const cookie = r?.cookies ?? '';
  const jar = Object.fromEntries(cookie.split(/;\s*/).filter(Boolean).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const skey = jar.p_skey || jar.skey;
  if (!skey) throw new Error('QQ did not return Qzone cookies (p_skey). Is QQ logged in?');
  const uin = String(jar.uin || jar.p_uin || (await onebot.call<any>('get_login_info')).user_id).replace(/^o0*/, '');
  cache = { at: Date.now(), cookie, uin, gtk: gtk(skey) };
  return cache;
}

/** Parse JSON, JSONP `cb({...})`, or `frameElement.callback({...})` HTML that Qzone CGIs return. */
export function parseQzone(text: string): any {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* not plain JSON */ }
  const m = /(?:callback|_Callback|cb|jsonp\w*)\s*\(\s*([\s\S]*)\)\s*;?\s*(?:<\/script>[\s\S]*)?$/i.exec(t) || /\(\s*(\{[\s\S]*\})\s*\)/.exec(t);
  if (m) {
    const body = m[1].trim();
    try { return JSON.parse(body); } catch {
      try { return Function(`"use strict";return (${body});`)(); } catch { /* fallthrough */ }
    }
  }
  return { raw: t.slice(0, 4000) };
}

export interface QzReq {
  /** Full URL, or "host/path" which is sent through the h5 proxy (e.g. "m.qzone.qq.com/cgi-bin/new/get_msgb"). */
  url: string;
  method?: 'GET' | 'POST';
  query?: Record<string, unknown>;
  form?: Record<string, unknown>;
  /** Set false to not add g_tk */
  gtk?: boolean;
}

const AUTH_FAIL = new Set([-3000, -100, -3, -10001, -10006, 1003]);

export async function qzone(req: QzReq, retried = false): Promise<any> {
  const a = await qzoneAuth(retried);
  const base = /^https?:\/\//.test(req.url) ? req.url : `https://h5.qzone.qq.com/proxy/domain/${req.url.replace(/^\/+/, '')}`;
  const u = new URL(base);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  if (req.gtk !== false && !u.searchParams.has('g_tk')) u.searchParams.set('g_tk', a.gtk);
  const headers: Record<string, string> = {
    cookie: a.cookie, 'user-agent': UA, referer: `https://user.qzone.qq.com/${a.uin}`, origin: 'https://user.qzone.qq.com', accept: '*/*',
  };
  let body: string | undefined;
  const method = req.method ?? (req.form ? 'POST' : 'GET');
  if (req.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(Object.entries(req.form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
  }
  const r = await fetch(u, { method, headers, body, redirect: 'follow' });
  const text = await r.text();
  if (!r.ok) throw new Error(`Qzone HTTP ${r.status} from ${u.hostname}${u.pathname}: ${text.slice(0, 200)}`);
  const data = parseQzone(text);
  const code = typeof data?.code === 'number' ? data.code : typeof data?.ret === 'number' ? data.ret : undefined;
  if (code !== undefined && AUTH_FAIL.has(code) && !retried) return qzone(req, true);
  if (code !== undefined && code !== 0) {
    const msg = data.message || data.msg || data.subcode || '';
    throw new Error(`Qzone error ${code}${msg ? `: ${msg}` : ''} (${u.pathname})`);
  }
  // some CGIs (uploads) report failures one level down: {"data":{"ret":-445,"msg":"…"}}
  if (data?.data && typeof data.data.ret === 'number' && data.data.ret < 0) {
    throw new Error(`Qzone error ${data.data.ret}${data.data.msg ? `: ${data.data.msg}` : ''} (${u.pathname})`);
  }
  return data;
}

export const myUin = async () => (await qzoneAuth()).uin;
