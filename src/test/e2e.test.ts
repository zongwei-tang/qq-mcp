/* Offline end-to-end: a fake OneBot v11 WebSocket server + the real MCP server over Streamable HTTP. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';

const TOKEN = 'test-onebot-token';
const MCP_TOKEN = 'x'.repeat(32);
const calls: { action: string; params: any }[] = [];
let sock: WebSocket | undefined;
let wss: WebSocketServer;
let httpSrv: any;
let base = '';

const friends = [{ user_id: 10001, nickname: 'Alice', remark: '小爱' }, { user_id: 10002, nickname: 'Bob', remark: '' }];
const groups = [{ group_id: 20001, group_name: '测试群', member_count: 3 }];
const hist = [
  { message_id: 1, time: 1763700000, user_id: 10001, message_type: 'private', sender: { nickname: 'Alice' }, message: [{ type: 'text', data: { text: 'hi ' } }, { type: 'face', data: { id: '14' } }] },
  { message_id: 2, time: 1763700060, user_id: 99999, self_id: 99999, message_type: 'private', sender: { nickname: 'Me' }, message: [{ type: 'image', data: { url: 'https://x/y.png' } }] },
];

function reply(action: string, params: any) {
  switch (action) {
    case 'get_login_info': return { user_id: 99999, nickname: 'Me' };
    case 'get_status': return { online: true, good: true };
    case 'get_friend_list': return friends;
    case 'get_group_list': return groups;
    case 'get_friend_msg_history': return { messages: hist };
    case 'send_msg': return { message_id: 777 };
    case 'get_group_member_list': return [{ user_id: 1, nickname: 'm' }];
    default: return null;
  }
}

before(async () => {
  wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    sock = ws;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      calls.push({ action: m.action, params: m.params });
      if (m.action === 'fail_me') return ws.send(JSON.stringify({ status: 'failed', retcode: 1400, wording: 'bad', echo: m.echo }));
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: reply(m.action, m.params), echo: m.echo }));
    });
  });
  await new Promise((r) => wss.once('listening', r));
  process.env.ONEBOT_WS_URL = `ws://127.0.0.1:${(wss.address() as any).port}/`;
  process.env.ONEBOT_ACCESS_TOKEN = TOKEN;
  const { buildServer, loadTools } = await import('../index.js');
  const { startHttpServer } = await import('../remote/http.js');
  const { onebot } = await import('../onebot.js');
  loadTools();
  httpSrv = await startHttpServer({ host: '127.0.0.1', port: 0, token: MCP_TOKEN, buildServer });
  base = `http://127.0.0.1:${httpSrv.address().port}`;
  onebot.start();
  await onebot.ready();
});

after(() => { httpSrv?.close(); wss?.close(); setTimeout(() => process.exit(0), 50).unref(); });

let sid = ''; let id = 1;
async function rpc(method: string, params: any = {}, auth = `/mcp/${MCP_TOKEN}`) {
  const r = await fetch(base + auth, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
  });
  if (r.headers.get('mcp-session-id')) sid = r.headers.get('mcp-session-id')!;
  const text = await r.text();
  if (r.status !== 200) return { status: r.status, text };
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return { status: 200, body: JSON.parse(line ? line.slice(6) : text) };
}
const callTool = async (name: string, args: any = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return r.body.result as { isError?: boolean; content: any[] };
};
const text = (r: any) => r.content[0].text as string;

test('rejects requests without the token', async () => {
  const r = await rpc('initialize', {}, '/mcp/wrong-token-wrong-token-wrong');
  assert.equal(r.status, 401);
});

test('initialize + list tools', async () => {
  const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.status, 200);
  assert.match(r.body.result.instructions, /QQ/);
  const l = await rpc('tools/list');
  const names = l.body.result.tools.map((t: any) => t.name);
  assert.ok(names.length > 250, `only ${names.length} tools`);
  for (const n of ['send_text', 'read_chat', 'send_qzone_msg', 'qzone_visitors', 'get_group_member_list', 'send_group_notice', 'qq_login']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('_send_group_notice') && !names.includes('get_recent_contact'));
});

test('catalog tool passes params and coerces numeric strings', async () => {
  const r = await callTool('get_group_member_list', { group_id: '20001' });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(calls.at(-1), { action: 'get_group_member_list', params: { group_id: 20001 } });
});

test('send_group_notice maps to _send_group_notice', async () => {
  await callTool('send_group_notice', { group_id: 20001, content: 'hello' });
  assert.equal(calls.at(-1)!.action, '_send_group_notice');
});

test('OneBot failures become tool errors', async () => {
  const r = await callTool('onebot_call', { action: 'fail_me' });
  assert.ok(r.isError);
  assert.match(text(r), /retcode 1400/);
});

test('send_text resolves a friend by remark and builds segments', async () => {
  const r = await callTool('send_text', { target: '小爱', text: 'hey [@10002] [face:1]', reply_to: 5 });
  assert.ok(!r.isError, text(r));
  const c = calls.at(-1)!;
  assert.equal(c.action, 'send_msg');
  assert.equal(c.params.user_id, 10001);
  assert.deepEqual(c.params.message.map((s: any) => s.type), ['reply', 'text', 'at', 'text', 'face']);
  assert.match(text(r), /777/);
});

test('ambiguous / unknown names give helpful errors', async () => {
  const r = await callTool('send_text', { target: 'nobody-here', text: 'x' });
  assert.ok(r.isError);
  assert.match(text(r), /find_contact/);
});

test('read_chat renders readable lines', async () => {
  const r = await callTool('read_chat', { target: 'qq:10001', count: 10 });
  const out = JSON.parse(text(r));
  assert.equal(out.count, 2);
  assert.match(out.messages[0], /^#1 2025-11-21 \d\d:\d\d:\d\d Alice\(10001\): hi \[表情14\]$/);
  assert.match(out.messages[1], /\[图片 https:\/\/x\/y\.png\]/);
});

test('live events: get_unread, list_recent_chats, wait_for_message', async () => {
  const ev = { post_type: 'message', message_type: 'group', group_id: 20001, user_id: 10002, self_id: 99999, message_id: 9, time: 1763700100, sender: { nickname: 'Bob', card: 'B' }, message: [{ type: 'text', data: { text: 'ping' } }] };
  const waiting = callTool('wait_for_message', { target: 'group:20001', contains: 'pong', timeout_seconds: 5 });
  sock!.send(JSON.stringify(ev));
  setTimeout(() => sock!.send(JSON.stringify({ ...ev, message_id: 10, message: [{ type: 'text', data: { text: 'pong!' } }] })), 100);
  const w = JSON.parse(text(await waiting));
  assert.equal(w.message_id, 10);
  const recent = JSON.parse(text(await callTool('list_recent_chats')));
  assert.equal(recent[0].chat, 'group:20001');
  assert.equal(recent[0].name, '测试群');
  const unread = JSON.parse(text(await callTool('get_unread')));
  assert.match(unread['group:20001'][0], /B\(10002\): ping/);
  assert.match(text(await callTool('get_unread')), /No unread/);
});

test('get_events filters by type', async () => {
  sock!.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', group_id: 20001, operator_id: 1, message_id: 9 }));
  await new Promise((r) => setTimeout(r, 100));
  const r = JSON.parse(text(await callTool('get_events', { types: ['notice.group_recall'] })));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'notice.group_recall');
});

test('login page script is valid JavaScript', async () => {
  const { loginPages } = await import('../remote/login-page.js');
  let out = '';
  await loginPages('/', { url: '/' } as any, { writeHead() {}, end(b: string) { out = b; } } as any);
  const js = /<script>([\s\S]*)<\/script>/.exec(out)![1];
  assert.doesNotThrow(() => new Function(js));
});
