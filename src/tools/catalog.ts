/* One MCP tool per OneBot action exposed by the QQ runtime, generated from its self-documented action catalog. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { onebot } from '../onebot.js';
import { defineTool, type JsonSchema } from './registry.js';

const require = createRequire(import.meta.url);

interface ActionDoc {
  name: string;
  category?: string;
  summary?: string;
  readOnly?: boolean;
  invariants?: string[];
  returns?: string;
  examples?: { summary: string; params: unknown; notes?: string }[];
  inputSchema: JsonSchema;
  stream?: boolean;
}

/** Category (as documented by the runtime) → toolset key. */
export const CATEGORY_KEYS: Record<string, string> = {
  消息: 'message', 好友: 'friend', 群信息: 'group_info', 群管理: 'group_admin', 群文件: 'group_file', 群相册: 'group_album',
  空间: 'qzone', 请求: 'request', 信息: 'system', 系统表情: 'face', 流式接口: 'stream', 扩展: 'extended',
};

/** Actions that are placeholders, typos or unsupported in the runtime. */
const SKIP = new Set([
  '_get_model_show', '_set_model_show', '.get_word_slices', 'check_url_safely', 'create_collection', 'get_recent_contact',
  'nc_get_packet_status', 'set_group_anonymous', 'set_group_anonymous_ban', 'set_restart', 'upload_foward_msg', 'bot_exit',
]);

const DESTRUCTIVE = /^(delete_|del_|_del_|set_group_kick|set_group_leave|set_group_ban|set_group_whole_ban|delete|clean_|cancel_|bot_exit)/;

/** Tool name for an action: strip leading "_" / "." (e.g. _send_group_notice → send_group_notice). */
export const toolNameFor = (action: string) => action.replace(/^[_.]+/, '');

/** Accept numeric strings wherever the schema wants integers (LLMs often quote QQ numbers). */
function coerce(schema: any, v: any): any {
  if (v === null || v === undefined || !schema) return v;
  const t = schema.type;
  const isInt = t === 'integer' || t === 'number' || (Array.isArray(t) && (t.includes('integer') || t.includes('number')));
  if (isInt && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  if (t === 'boolean' && typeof v === 'string') return /^(true|1|yes)$/i.test(v);
  if (t === 'array' && Array.isArray(v)) return v.map((x) => coerce(schema.items, x));
  if (t === 'array' && typeof v !== 'object' && schema.items) return [coerce(schema.items, v)];
  if (t === 'object' && v && typeof v === 'object' && schema.properties) {
    const o = { ...v };
    for (const [k, ps] of Object.entries(schema.properties)) if (k in o) o[k] = coerce(ps, o[k]);
    return o;
  }
  return v;
}

/** Make integer QQ ids also accept strings in the advertised schema. */
function widen(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(widen);
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as any).map(([pk, pv]) => [pk, widen(pv)])) : k === 'items' ? widen(v) : v;
  if (out.type === 'integer' && out['x-role']) out.type = ['integer', 'string'];
  for (const k of Object.keys(out)) if (k.startsWith('x-')) delete out[k];
  return out;
}

function describe(a: ActionDoc): string {
  const parts = [a.summary || a.name];
  const ex = a.examples?.find((e) => e.notes)?.notes;
  if (ex) parts.push(ex);
  if (a.invariants?.length) parts.push(`Rules: ${a.invariants.join('; ')}.`);
  if (a.returns) parts.push(`Returns: ${a.returns}`);
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 1200);
}

/**
 * The action catalog comes from SnowLuma's own npm package (@snowluma/mcp, installed as a dependency),
 * so it always matches the runtime and is not copied into this repo. QQ_CATALOG_FILE can point to a JSON array instead.
 */
export function loadCatalog(): ActionDoc[] {
  if (process.env.QQ_CATALOG_FILE) return JSON.parse(readFileSync(process.env.QQ_CATALOG_FILE, 'utf8')) as ActionDoc[];
  return require('@snowluma/mcp/dist/generated/catalog.js').ACTIONS as ActionDoc[];
}

/** Feed actions return each item's raw rendered HTML (often 50k+ chars) next to structured fields: drop it by default. */
const HTML_HEAVY = /qzone.*feed|feed.*qzone/;
function dropHtml(v: any): any {
  if (Array.isArray(v)) return v.map(dropHtml);
  if (v && typeof v === 'object') { const o: any = {}; for (const [k, x] of Object.entries(v)) if (k !== 'html') o[k] = dropHtml(x); return o; }
  return v;
}

export function registerCatalog() {
  for (const a of loadCatalog()) {
    if (SKIP.has(a.name)) continue;
    const schema = a.inputSchema ?? { type: 'object', properties: {} };
    const heavy = HTML_HEAVY.test(a.name) && a.readOnly;
    const advertised = heavy ? { ...schema, properties: { ...(schema.properties ?? {}), include_html: { type: 'boolean', description: 'Also return each feed item\'s raw HTML (large)', default: false } } } : schema;
    defineTool({
      name: toolNameFor(a.name),
      category: CATEGORY_KEYS[a.category ?? ''] ?? 'extended',
      description: describe(a),
      inputSchema: widen({ ...advertised, type: 'object', properties: advertised.properties ?? {} }),
      readOnly: !!a.readOnly,
      destructive: DESTRUCTIVE.test(a.name),
      handler: async (args) => {
        const { include_html, ...rest } = args ?? {};
        const out = await onebot.call(a.name, coerce(schema, heavy ? rest : (args ?? {})));
        return heavy && !include_html ? dropHtml(out) : out;
      },
    });
  }
}
