/* Tool registry. Every tool carries a plain JSON Schema so OneBot action schemas pass through untouched. */
import { settings } from '../config.js';

export type JsonSchema = { type: 'object'; properties: Record<string, any>; required?: string[]; additionalProperties?: boolean; [k: string]: any };

export interface ImageOut { __image: { data: string; mimeType: string }; text?: string }

export interface ToolDef {
  name: string;
  /** toolset key (QQ_TOOLSETS filters on it) */
  category: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: any) => Promise<unknown>;
  readOnly?: boolean;
  destructive?: boolean;
}

export const tools: ToolDef[] = [];
const byName = new Map<string, ToolDef>();

export function defineTool(t: ToolDef) {
  if (byName.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
  byName.set(t.name, t);
  tools.push(t);
}

export const getTool = (name: string) => byName.get(name);

/** Small schema helpers for hand-written tools. */
export const s = {
  obj(properties: Record<string, any>, required: string[] = []): JsonSchema {
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  },
  str: (description: string, extra: Record<string, any> = {}) => ({ type: 'string', description, ...extra }),
  int: (description: string, extra: Record<string, any> = {}) => ({ type: 'integer', description, ...extra }),
  num: (description: string, extra: Record<string, any> = {}) => ({ type: 'number', description, ...extra }),
  bool: (description: string, extra: Record<string, any> = {}) => ({ type: 'boolean', description, ...extra }),
  arr: (items: any, description: string, extra: Record<string, any> = {}) => ({ type: 'array', items, description, ...extra }),
  enum: (values: string[], description: string, extra: Record<string, any> = {}) => ({ type: 'string', enum: values, description, ...extra }),
  /** QQ number / group number. Accepts numbers or numeric strings. */
  id: (description: string) => ({ type: ['integer', 'string'], description }),
};

export function enabled(t: ToolDef): boolean {
  if (settings.disabledTools.has(t.name)) return false;
  if (settings.readOnly && !t.readOnly) return false;
  if (settings.toolsets.size && !settings.toolsets.has(t.category) && t.category !== 'login') return false;
  return true;
}

function prune(v: any, depth = 0): any {
  if (depth > 40) return v;
  if (Array.isArray(v)) return v.map((x) => prune(x, depth + 1));
  if (v && typeof v === 'object') {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === undefined || x === '') continue;
      if (Array.isArray(x) && x.length === 0) continue;
      o[k] = prune(x, depth + 1);
    }
    return o;
  }
  return v;
}

export function render(out: unknown): { content: any[] } {
  if (out && typeof out === 'object' && '__image' in (out as any)) {
    const img = (out as ImageOut).__image;
    const content: any[] = [{ type: 'image', data: img.data, mimeType: img.mimeType }];
    if ((out as ImageOut).text) content.unshift({ type: 'text', text: (out as ImageOut).text });
    return { content };
  }
  let text = typeof out === 'string' ? out : JSON.stringify(prune(out));
  if (text === undefined) text = 'ok';
  if (text.length > settings.maxOutputChars) {
    text = `${text.slice(0, settings.maxOutputChars)}\n…[truncated: ${text.length} chars total. Ask for fewer items (count/limit) or a narrower range.]`;
  }
  return { content: [{ type: 'text', text }] };
}
