/* Friend / group lookup with a short cache, and "target" resolution for convenience tools. */
import { onebot } from './onebot.js';

export interface Friend { user_id: number; nickname?: string; remark?: string; [k: string]: any }
export interface Group { group_id: number; group_name?: string; member_count?: number; [k: string]: any }

let friends: { at: number; list: Friend[] } | undefined;
let groups: { at: number; list: Group[] } | undefined;
const TTL = 5 * 60_000;

export async function getFriends(refresh = false): Promise<Friend[]> {
  if (!refresh && friends && Date.now() - friends.at < TTL) return friends.list;
  const list = (await onebot.call<Friend[]>('get_friend_list', { no_cache: refresh })) ?? [];
  friends = { at: Date.now(), list };
  return list;
}

export async function getGroups(refresh = false): Promise<Group[]> {
  if (!refresh && groups && Date.now() - groups.at < TTL) return groups.list;
  const list = (await onebot.call<Group[]>('get_group_list', { no_cache: refresh })) ?? [];
  groups = { at: Date.now(), list };
  return list;
}

export const friendName = (f: Friend) => f.remark || f.nickname || String(f.user_id);

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, '');

export interface Match { type: 'private' | 'group'; id: number; name: string; score: number; extra?: string }

export async function searchContacts(query: string, kinds: ('friend' | 'group')[] = ['friend', 'group'], limit = 20): Promise<Match[]> {
  const q = norm(query);
  const out: Match[] = [];
  const score = (fields: unknown[]) => {
    let best = 0;
    for (const f of fields) {
      const v = norm(f);
      if (!v) continue;
      if (v === q) best = Math.max(best, 100);
      else if (v.startsWith(q)) best = Math.max(best, 80);
      else if (v.includes(q)) best = Math.max(best, 60);
    }
    return best;
  };
  if (kinds.includes('friend')) for (const f of await getFriends()) {
    const sc = score([f.remark, f.nickname, f.user_id]);
    if (sc) out.push({ type: 'private', id: f.user_id, name: friendName(f), score: sc, extra: f.remark && f.nickname ? `昵称 ${f.nickname}` : undefined });
  }
  if (kinds.includes('group')) for (const g of await getGroups()) {
    const sc = score([g.group_name, g.group_remark, g.group_id]);
    if (sc) out.push({ type: 'group', id: g.group_id, name: g.group_name ?? String(g.group_id), score: sc, extra: g.member_count ? `${g.member_count}人` : undefined });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface Target { type: 'private' | 'group'; id: number; name?: string }

/**
 * Resolve a chat target. Accepts "qq:123" / "friend:123" / "user:123", "group:123", a bare number
 * (friend first, then group), or a name (friend remark/nickname or group name).
 */
export async function resolveTarget(raw: unknown): Promise<Target> {
  if (raw && typeof raw === 'object') {
    const o = raw as any;
    if (o.group_id) return { type: 'group', id: Number(o.group_id) };
    if (o.user_id) return { type: 'private', id: Number(o.user_id) };
  }
  const t = String(raw ?? '').trim();
  if (!t) throw new Error('target is required: "qq:<QQ号>", "group:<群号>", a number, or a friend/group name');
  let m = /^(?:qq|friend|user|private|u)[:：](\d+)$/i.exec(t);
  if (m) return { type: 'private', id: Number(m[1]) };
  m = /^(?:group|g|qun|群)[:：](\d+)$/i.exec(t);
  if (m) return { type: 'group', id: Number(m[1]) };
  if (/^\d{5,12}$/.test(t)) {
    const id = Number(t);
    const f = (await getFriends()).find((x) => x.user_id === id);
    if (f) return { type: 'private', id, name: friendName(f) };
    const g = (await getGroups()).find((x) => x.group_id === id);
    if (g) return { type: 'group', id, name: g.group_name };
    return { type: 'private', id };
  }
  const hits = await searchContacts(t);
  if (!hits.length) throw new Error(`No friend or group matches "${t}". Use find_contact to search, or pass "qq:<QQ号>" / "group:<群号>".`);
  const top = hits.filter((h) => h.score === hits[0].score);
  if (top.length > 1) {
    throw new Error(`"${t}" is ambiguous: ${top.slice(0, 8).map((h) => `${h.type === 'group' ? 'group' : 'qq'}:${h.id} ${h.name}`).join('; ')}. Pass one of these ids.`);
  }
  return { type: hits[0].type, id: hits[0].id, name: hits[0].name };
}

export const targetLabel = (t: Target) => `${t.type === 'group' ? 'group' : 'qq'}:${t.id}${t.name ? ` (${t.name})` : ''}`;
