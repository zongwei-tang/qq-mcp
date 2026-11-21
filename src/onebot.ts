/* OneBot v11 client over one forward WebSocket: actions (echo-matched) + live events. */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { settings } from './config.js';

export interface OneBotEvent {
  /** Monotonic id assigned here, for get_events(since=...). */
  _seq: number;
  post_type: string;
  time?: number;
  self_id?: number;
  [k: string]: any;
}

export class OneBotError extends Error {
  constructor(public action: string, public retcode: number, msg: string, public data?: unknown) {
    super(`${action} failed (retcode ${retcode}): ${msg}`);
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; action: string };

class OneBotClient extends EventEmitter {
  private ws?: WebSocket;
  private pending = new Map<string, Pending>();
  private nextEcho = 1;
  private seq = 0;
  private retryMs = 1000;
  private started = false;
  readonly events: OneBotEvent[] = [];
  connected = false;
  lastError = '';
  selfId?: number;

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect() {
    const headers: Record<string, string> = {};
    if (settings.onebotToken) headers.Authorization = `Bearer ${settings.onebotToken}`;
    const ws = new WebSocket(settings.onebotWs, { headers, maxPayload: 256 * 1024 * 1024 });
    this.ws = ws;
    ws.on('open', () => { this.connected = true; this.retryMs = 1000; this.lastError = ''; this.emit('open'); });
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && msg.echo !== undefined && this.pending.has(String(msg.echo))) {
        const p = this.pending.get(String(msg.echo))!;
        this.pending.delete(String(msg.echo));
        clearTimeout(p.timer);
        if (msg.status === 'failed' || (typeof msg.retcode === 'number' && msg.retcode !== 0 && msg.retcode !== 1)) {
          p.reject(new OneBotError(p.action, msg.retcode, msg.wording || msg.message || msg.msg || 'failed', msg.data));
        } else p.resolve(msg.data);
        return;
      }
      if (msg && msg.post_type) this.pushEvent(msg);
    });
    ws.on('error', (e) => { this.lastError = e.message; });
    ws.on('close', () => {
      this.connected = false;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('QQ connection closed')); }
      this.pending.clear();
      setTimeout(() => this.connect(), this.retryMs).unref();
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    });
  }

  private pushEvent(e: any) {
    if (e.post_type === 'meta_event') {
      if (e.self_id) this.selfId = e.self_id;
      if (e.meta_event_type === 'heartbeat') return; // noise
    }
    const ev: OneBotEvent = { _seq: ++this.seq, ...e };
    if (ev.self_id) this.selfId = ev.self_id;
    this.events.push(ev);
    if (this.events.length > settings.eventBuffer) this.events.splice(0, this.events.length - settings.eventBuffer);
    this.emit('event', ev);
  }

  /** Wait until connected (or throw a helpful error). */
  async ready(timeoutMs = 8000) {
    this.start();
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        this.off('open', on);
        reject(new Error(`QQ is not connected (${settings.onebotWs}${this.lastError ? `: ${this.lastError}` : ''}). ` +
          'If QQ is not logged in yet, call qq_login_status / qq_login to log in with a QR code.'));
      }, timeoutMs);
      const on = () => { clearTimeout(t); resolve(); };
      this.once('open', on);
    });
  }

  async call<T = any>(action: string, params: Record<string, unknown> = {}, timeoutMs = settings.actionTimeout): Promise<T> {
    await this.ready();
    const echo = String(this.nextEcho++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`${action} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer, action });
      this.ws!.send(JSON.stringify({ action, params, echo }), (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(echo); reject(err); }
      });
    });
  }

  latestSeq() { return this.seq; }

  /** Resolve with the first event (after now) matching `pred`, or undefined on timeout. */
  waitFor(pred: (e: OneBotEvent) => boolean, timeoutMs: number): Promise<OneBotEvent | undefined> {
    return new Promise((resolve) => {
      const on = (e: OneBotEvent) => { if (pred(e)) { clearTimeout(t); this.off('event', on); resolve(e); } };
      const t = setTimeout(() => { this.off('event', on); resolve(undefined); }, timeoutMs);
      this.on('event', on);
    });
  }
}

export const onebot = new OneBotClient();
onebot.setMaxListeners(100);
