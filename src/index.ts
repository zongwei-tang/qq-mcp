#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from './config.js';
import { onebot } from './onebot.js';
import { registerCatalog } from './tools/catalog.js';
import { registerChatTools } from './tools/chat.js';
import { registerLoginTools } from './tools/login.js';
import { registerQzoneTools } from './tools/qzone.js';
import { defineTool, enabled, getTool, render, s, tools } from './tools/registry.js';

let loaded = false;
export function loadTools() {
  if (loaded) return tools;
  loaded = true;
  registerLoginTools();
  registerChatTools();
  registerQzoneTools();
  registerCatalog();
  defineTool({
    name: 'list_tools_by_category', category: 'raw', readOnly: true,
    description: 'Overview of every tool grouped by category (message, friend, group_info, group_admin, group_file, group_album, qzone, qzone_web, chat, events, extended…), to find the right one.',
    inputSchema: s.obj({ category: s.str('Only this category') }),
    handler: async ({ category }) => {
      const out: Record<string, string[]> = {};
      for (const t of tools.filter(enabled)) if (!category || t.category === category) (out[t.category] ??= []).push(`${t.name}: ${t.description.split(/(?<=[。.])\s/)[0].slice(0, 90)}`);
      return out;
    },
  });
  return tools;
}

export const INSTRUCTIONS = [
  'QQ as the user\'s own account (a real QQ client logged in on the server).',
  'If a tool says QQ is not connected, call qq_login: it returns the login window with a QR code; show it to the user to scan with the QQ phone app, then qq_login wait=true.',
  'Start with whoami, list_recent_chats, get_unread. Find people/groups with find_contact; targets are "qq:<QQ号>" or "group:<群号>" (names work too).',
  'Read with read_chat / search_chat, send with send_text / send_image / send_file / reply_to_message. view_image lets you see pictures.',
  'QQ空间: get_qzone_feeds (friends\' feed), get_qzone_msg_list / get_qzone_msg_detail, send_qzone_msg (说说 with images), like_qzone, comment_qzone, plus qzone_visitors, qzone_board_*, qzone_albums, qzone_like_list.',
  'Groups: get_group_member_list, set_group_ban/kick/card/admin, send_group_notice, group files and albums. Live: wait_for_message, get_events.',
  'Every OneBot action is a tool; onebot_call reaches anything else.',
].join(' ');

export function buildServer() {
  loadTools();
  const server = new Server({ name: 'qq-mcp', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.filter(enabled).map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: true },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = getTool(req.params.name);
    if (!t || !enabled(t)) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] };
    try {
      return render(await t.handler(req.params.arguments ?? {}));
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });
  return server;
}

async function cli(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd === 'serve') {
    const { startHttpServer, MIN_TOKEN_LENGTH } = await import('./remote/http.js');
    const token = (process.env.MCP_AUTH_TOKEN || '').trim();
    if (token.length < MIN_TOKEN_LENGTH) {
      console.error(`qq-mcp serve: set MCP_AUTH_TOKEN (at least ${MIN_TOKEN_LENGTH} characters). Without it anyone could use your QQ account.`);
      process.exit(2);
    }
    const port = Number(process.env.PORT || 8000);
    const host = process.env.HOST || '0.0.0.0';
    loadTools();
    const { loginPages } = await import('./remote/login-page.js');
    await startHttpServer({ host, port, token, buildServer, pages: loginPages, log: (l) => console.log(`[http] ${l}`) });
    console.log('login page: /login/<MCP_AUTH_TOKEN>');
    console.log(`qq-mcp ${VERSION} listening on http://${host}:${port}/mcp (${tools.filter(enabled).length} tools)`);
    onebot.start();
    return;
  }
  if (cmd === 'tools') {
    const ts = loadTools().filter(enabled);
    const cats = new Map<string, number>();
    for (const t of ts) {
      cats.set(t.category, (cats.get(t.category) ?? 0) + 1);
      if (rest.includes('--markdown')) continue;
      if (!rest.includes('--count')) console.log(`${t.category.padEnd(12)} ${t.name.padEnd(40)} ${t.description.slice(0, 90)}`);
    }
    if (rest.includes('--markdown')) {
      const out = [`# Tools (${ts.length})\n`, 'Generated by `qq-mcp tools --markdown`.\n'];
      for (const c of cats.keys()) {
        out.push(`\n## ${c} (${cats.get(c)})\n\n| Tool | What it does |\n| --- | --- |`);
        for (const t of ts.filter((x) => x.category === c)) out.push(`| \`${t.name}\` | ${t.description.replace(/\|/g, '\\|').slice(0, 220)} |`);
      }
      console.log(out.join('\n'));
      return;
    }
    console.log(`\n${ts.length} tools: ${[...cats].map(([c, n]) => `${c} ${n}`).join(', ')}`);
    return;
  }
  if (cmd === '--version' || cmd === 'version') { console.log(VERSION); return; }
  console.log(`qq-mcp ${VERSION} — MCP server for your own QQ account

  qq-mcp                 run over stdio
  qq-mcp serve           run Streamable HTTP on $PORT (needs MCP_AUTH_TOKEN); endpoint /mcp or /mcp/<token>
  qq-mcp tools [--count|--markdown]   list tools`);
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
const args = process.argv.slice(2);
if (!isMain) {
  // imported (tests)
} else if (args.length) {
  cli(args).catch((e) => { console.error(e.message); process.exit(1); });
} else {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  onebot.start();
}
