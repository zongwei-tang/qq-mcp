/* `qq-mcp serve`: Streamable HTTP endpoint for remote clients (claude.ai connectors, cloud sessions). */
import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export const MIN_TOKEN_LENGTH = 24;

export interface ServeOptions {
  host: string;
  port: number;
  token: string;
  buildServer: () => Server;
  /** Extra GET routes under /<name>/<token>/... (token already checked). Return true if handled. */
  pages?: (sub: string, req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  log?: (line: string) => void;
}

const hash = (s: string) => createHash('sha256').update(s).digest();
export const tokenMatches = (given: string, token: string) => !!given && timingSafeEqual(hash(given), hash(token));

async function readBody(req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new Error('body too large'); chunks.push(c as Buffer); }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

export function startHttpServer(o: ServeOptions): Promise<http.Server> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server; last: number }>();
  const log = o.log ?? (() => {});
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, s] of sessions) if (s.last < cutoff) { s.transport.close().catch(() => {}); sessions.delete(id); }
  }, 60_000);
  sweeper.unref();

  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
      const pg = /^\/login\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (pg && o.pages && req.method === 'GET') {
        if (!tokenMatches(decodeURIComponent(pg[1]), o.token)) { res.writeHead(401); res.end('unauthorized'); return; }
        if (await o.pages(pg[2] ?? '/', req, res)) return;
        res.writeHead(404); res.end(); return;
      }
      // /mcp with "Authorization: Bearer <token>", or /mcp/<token> for clients that only take a URL
      const m = /^\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]?.trim() ?? '';
      const given = m[1] ? decodeURIComponent(m[1]) : bearer;
      if (!tokenMatches(given, o.token)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        log(`401 ${req.method} from ${req.headers['x-forwarded-for'] ?? req.socket.remoteAddress}`);
        return;
      }
      const sid = req.headers['mcp-session-id'] as string | undefined;
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      let entry = sid ? sessions.get(sid) : undefined;
      if (!entry) {
        if (req.method !== 'POST' || !(Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body))) {
          res.writeHead(sid ? 404 : 400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sid ? 'Unknown session (server restarted?); initialize again' : 'Send initialize first' }, id: null }));
          return;
        }
        const server = o.buildServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { sessions.set(id, { transport, server, last: Date.now() }); log(`session ${id.slice(0, 8)} opened (${sessions.size} open)`); },
        });
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
        await server.connect(transport);
        entry = { transport, server, last: Date.now() };
      }
      entry.last = Date.now();
      await entry.transport.handleRequest(req, res, body);
    } catch (e) {
      log(`error: ${(e as Error).message}`);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'internal error' })); }
    }
  });
  srv.requestTimeout = 0; // tools like wait_for_message hold a request open
  srv.on('close', () => clearInterval(sweeper));
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(o.port, o.host, () => resolve(srv)); });
}
