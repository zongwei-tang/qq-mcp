/* Hand-written convenience tools: resolve people/groups by name, read and send in one call, live events. */
import { onebot, type OneBotEvent } from '../onebot.js';
import { friendName, getFriends, getGroups, resolveTarget, searchContacts, targetLabel, type Target } from '../contacts.js';
import { compactEvent, compactMessage, fileRef, messageText, parseInline, type Segment } from '../format.js';
import { imageForModel, loadBytes, saveDownload } from '../media.js';
import { defineTool, s } from './registry.js';

const TARGET = s.str('Who to talk to: "qq:<QQ号>" for a friend/private chat, "group:<群号>" for a group, a bare number, or a friend remark/nickname/group name (must be unambiguous).');

const chatKey = (t: Target) => `${t.type === 'group' ? 'group' : 'qq'}:${t.id}`;
const eventChatKey = (e: any) => (e.group_id ? `group:${e.group_id}` : `qq:${e.message_type === 'private' && e.target_id ? e.target_id : e.user_id}`);
const isMsg = (e: OneBotEvent) => e.post_type === 'message' || e.post_type === 'message_sent';

/** Local read markers (seq of the last event the agent has seen per chat). */
const readUpTo = new Map<string, number>();
/** Individual events already handed to the agent (e.g. by wait_for_message). */
const seen = new Set<number>();

async function send(t: Target, message: Segment[] | string) {
  const r = await onebot.call<{ message_id: number }>('send_msg', t.type === 'group'
    ? { message_type: 'group', group_id: t.id, message }
    : { message_type: 'private', user_id: t.id, message });
  return { sent: true, to: targetLabel(t), message_id: r?.message_id };
}

async function history(t: Target, count: number, before?: number) {
  const params: any = { count, message_id: before ?? 0, reverse_order: true };
  const r = t.type === 'group'
    ? await onebot.call<any>('get_group_msg_history', { group_id: t.id, ...params })
    : await onebot.call<any>('get_friend_msg_history', { user_id: t.id, ...params });
  const msgs: any[] = r?.messages ?? (Array.isArray(r) ? r : []);
  return msgs.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || (a.message_seq ?? 0) - (b.message_seq ?? 0));
}

export function registerChatTools() {
  defineTool({
    name: 'whoami', category: 'chat', readOnly: true,
    description: 'Who is logged in: QQ number, nickname, online status, and how many friends/groups. Start here.',
    inputSchema: s.obj({}),
    handler: async () => {
      const me = await onebot.call('get_login_info');
      const [status, fl, gl] = await Promise.all([
        onebot.call('get_status').catch(() => undefined), getFriends().catch(() => []), getGroups().catch(() => []),
      ]);
      return { ...me, status, friends: fl.length, groups: gl.length };
    },
  });

  defineTool({
    name: 'find_contact', category: 'chat', readOnly: true,
    description: 'Search friends (by remark, nickname or QQ number) and groups (by name or number). Returns ids to use as targets ("qq:<id>" / "group:<id>").',
    inputSchema: s.obj({ query: s.str('Name or number fragment'), kind: s.enum(['all', 'friend', 'group'], 'Limit to friends or groups', { default: 'all' }), limit: s.int('Max results', { default: 20 }) }, ['query']),
    handler: async ({ query, kind = 'all', limit = 20 }) => {
      const kinds = kind === 'friend' ? ['friend'] : kind === 'group' ? ['group'] : ['friend', 'group'];
      const hits = await searchContacts(String(query), kinds as any, limit);
      return hits.map((h) => ({ target: `${h.type === 'group' ? 'group' : 'qq'}:${h.id}`, name: h.name, ...(h.extra ? { info: h.extra } : {}) }));
    },
  });

  defineTool({
    name: 'list_contacts', category: 'chat', readOnly: true,
    description: 'Compact list of all friends and/or groups (target id + display name), with paging. Use refresh=true after adding friends/joining groups.',
    inputSchema: s.obj({ kind: s.enum(['friend', 'group', 'all'], 'Which list', { default: 'all' }), offset: s.int('Skip this many', { default: 0 }), limit: s.int('Max items', { default: 200 }), refresh: s.bool('Bypass the 5-minute cache', { default: false }) }),
    handler: async ({ kind = 'all', offset = 0, limit = 200, refresh = false }) => {
      const out: any = {};
      if (kind !== 'group') { const f = await getFriends(refresh); out.friends_total = f.length; out.friends = f.slice(offset, offset + limit).map((x) => `qq:${x.user_id} ${friendName(x)}${x.remark && x.nickname ? ` (${x.nickname})` : ''}`); }
      if (kind !== 'friend') { const g = await getGroups(refresh); out.groups_total = g.length; out.groups = g.slice(offset, offset + limit).map((x) => `group:${x.group_id} ${x.group_name ?? ''}${x.member_count ? ` [${x.member_count}人]` : ''}`); }
      return out;
    },
  });

  defineTool({
    name: 'read_chat', category: 'chat', readOnly: true,
    description: 'Read the latest messages of a private or group chat as readable lines (oldest first). Page back with before_message_id = the oldest message_id you got. Marks the chat as read for get_unread. Note: older server history is reachable once the chat has had at least one message since QQ logged in on the server; everything seen since then is kept.',
    inputSchema: s.obj({ target: TARGET, count: s.int('How many messages (max 200)', { default: 30 }), before_message_id: s.int('Return messages older than this message_id'), mark_read_on_qq: s.bool('Also clear the unread badge in QQ itself', { default: false }) }, ['target']),
    handler: async ({ target, count = 30, before_message_id, mark_read_on_qq = false }) => {
      const t = await resolveTarget(target);
      let msgs = await history(t, Math.min(Math.max(1, count), 200), before_message_id);
      if (before_message_id) msgs = msgs.filter((m) => m.message_id !== before_message_id);
      readUpTo.set(chatKey(t), onebot.latestSeq());
      if (mark_read_on_qq) await onebot.call(t.type === 'group' ? 'mark_group_msg_as_read' : 'mark_private_msg_as_read', t.type === 'group' ? { group_id: t.id } : { user_id: t.id }).catch(() => {});
      return { chat: targetLabel(t), count: msgs.length, messages: msgs.map((m) => { const c = compactMessage(m); return `#${c.message_id} ${c.time} ${c.from}: ${c.text}`; }) };
    },
  });

  defineTool({
    name: 'search_chat', category: 'chat', readOnly: true,
    description: 'Find messages containing a keyword (case-insensitive) in one chat by scanning its history backwards.',
    inputSchema: s.obj({ target: TARGET, keyword: s.str('Text to look for'), scan: s.int('How many recent messages to scan (max 2000)', { default: 400 }), from_user: s.id('Only messages from this QQ number') }, ['target', 'keyword']),
    handler: async ({ target, keyword, scan = 400, from_user }) => {
      const t = await resolveTarget(target);
      const kw = String(keyword).toLowerCase();
      const hits: string[] = [];
      let before: number | undefined; let scanned = 0;
      while (scanned < Math.min(scan, 2000)) {
        const page = await history(t, 100, before);
        const fresh = before ? page.filter((m) => m.message_id !== before) : page;
        if (!fresh.length) break;
        scanned += fresh.length;
        for (const m of fresh.reverse()) {
          if (from_user && String(m.user_id) !== String(from_user)) continue;
          const c = compactMessage(m);
          if (c.text.toLowerCase().includes(kw)) hits.push(`#${c.message_id} ${c.time} ${c.from}: ${c.text}`);
        }
        before = fresh[fresh.length - 1].message_id;
      }
      return { chat: targetLabel(t), scanned, matches: hits.length, messages: hits };
    },
  });

  defineTool({
    name: 'send_text', category: 'chat',
    description: 'Send a text message to a friend or group. Inline tokens: [@QQ号] mention, [@all] @全体, [face:ID] QQ emoji, [reply:message_id] quote, [image:URL或路径] picture. Or use reply_to / mention.',
    inputSchema: s.obj({ target: TARGET, text: s.str('Message text'), reply_to: s.int('message_id to quote-reply'), mention: s.arr({ type: ['integer', 'string'] }, 'QQ numbers to @ at the start ("all" for 全体成员)') }, ['target', 'text']),
    handler: async ({ target, text, reply_to, mention }) => {
      const t = await resolveTarget(target);
      const segs: Segment[] = [];
      if (reply_to) segs.push({ type: 'reply', data: { id: String(reply_to) } });
      for (const q of mention ?? []) segs.push({ type: 'at', data: { qq: String(q) } }, { type: 'text', data: { text: ' ' } });
      segs.push(...parseInline(String(text)));
      return send(t, segs);
    },
  });

  defineTool({
    name: 'send_image', category: 'chat',
    description: 'Send a picture (http(s) URL, local path on the server, file://, or base64) to a friend or group, optionally with a caption. Set as_sticker to send it as a 表情 sticker.',
    inputSchema: s.obj({ target: TARGET, image: s.str('URL / path / base64 of the image'), caption: s.str('Text sent with the image'), as_sticker: s.bool('Send as sticker (subType 1)', { default: false }) }, ['target', 'image']),
    handler: async ({ target, image, caption, as_sticker }) => {
      const t = await resolveTarget(target);
      const segs: Segment[] = [{ type: 'image', data: { file: fileRef(image), ...(as_sticker ? { sub_type: 1, subType: 1 } : {}) } }];
      if (caption) segs.push({ type: 'text', data: { text: String(caption) } });
      return send(t, segs);
    },
  });

  defineTool({
    name: 'send_voice', category: 'chat',
    description: 'Send a voice message (mp3/wav/silk/amr… from URL, path or base64; converted automatically).',
    inputSchema: s.obj({ target: TARGET, file: s.str('URL / path / base64 of the audio') }, ['target', 'file']),
    handler: async ({ target, file }) => send(await resolveTarget(target), [{ type: 'record', data: { file: fileRef(file) } }]),
  });

  defineTool({
    name: 'send_video', category: 'chat',
    description: 'Send a video (mp4 from URL, path or base64).',
    inputSchema: s.obj({ target: TARGET, file: s.str('URL / path / base64 of the video'), thumb: s.str('Optional cover image') }, ['target', 'file']),
    handler: async ({ target, file, thumb }) => send(await resolveTarget(target), [{ type: 'video', data: { file: fileRef(file), ...(thumb ? { thumb: fileRef(thumb) } : {}) } }]),
  });

  defineTool({
    name: 'send_file', category: 'chat',
    description: 'Send a file to a friend or upload it to a group (群文件). Source: URL, path on the server, or base64.',
    inputSchema: s.obj({ target: TARGET, file: s.str('URL / path / base64'), name: s.str('File name shown in QQ (default: from path/URL)'), folder_id: s.str('Group file folder id (groups only)') }, ['target', 'file']),
    handler: async ({ target, file, name, folder_id }) => {
      const t = await resolveTarget(target);
      let ref = fileRef(file);
      if (/^https?:\/\//i.test(ref)) { // runtimes want a local file for uploads
        const fname = name || decodeURIComponent(new URL(ref).pathname.split('/').pop() || 'file');
        ref = await saveDownload(await loadBytes(ref), fname);
        name = name || fname;
      }
      const filePath = ref.startsWith('file://') ? decodeURIComponent(ref.slice(7)) : ref;
      const fname = name || filePath.split('/').pop() || 'file';
      const r = t.type === 'group'
        ? await onebot.call('upload_group_file', { group_id: t.id, file: filePath, name: fname, ...(folder_id ? { folder: folder_id, folder_id } : {}) }, 600_000)
        : await onebot.call('upload_private_file', { user_id: t.id, file: filePath, name: fname }, 600_000);
      return { sent: true, to: targetLabel(t), name: fname, result: r };
    },
  });

  defineTool({
    name: 'send_message', category: 'chat',
    description: 'Send any OneBot message to a friend or group: a CQ-code string or an array of segments, e.g. [{"type":"text","data":{"text":"hi"}},{"type":"image","data":{"file":"https://…"}}]. Segment types: text, at, face, mface, image, record, video, file, reply, forward, json, xml, poke, dice, rps, music, contact, markdown, location, share.',
    inputSchema: s.obj({ target: TARGET, message: { description: 'Segment array or CQ-code string', type: ['array', 'string'], items: { type: 'object' } } }, ['target', 'message']),
    handler: async ({ target, message }) => send(await resolveTarget(target), message),
  });

  defineTool({
    name: 'reply_to_message', category: 'chat',
    description: 'Quote-reply to a message by its message_id (works for group and private messages). Optionally @ the original sender.',
    inputSchema: s.obj({ message_id: s.int('message_id to reply to'), text: s.str('Reply text (inline tokens like send_text)'), mention_sender: s.bool('Also @ the sender (groups)', { default: false }) }, ['message_id', 'text']),
    handler: async ({ message_id, text, mention_sender }) => {
      const m = await onebot.call<any>('get_msg', { message_id });
      const t: Target = m.group_id ? { type: 'group', id: Number(m.group_id) } : { type: 'private', id: Number(m.user_id === m.self_id ? m.target_id ?? m.user_id : m.user_id) };
      const segs: Segment[] = [{ type: 'reply', data: { id: String(message_id) } }];
      if (mention_sender && t.type === 'group') segs.push({ type: 'at', data: { qq: String(m.user_id) } }, { type: 'text', data: { text: ' ' } });
      segs.push(...parseInline(String(text)));
      return send(t, segs);
    },
  });

  defineTool({
    name: 'forward_messages', category: 'chat',
    description: 'Forward existing messages (by message_id) to a friend or group — as one 合并转发 bundle (default) or one by one.',
    inputSchema: s.obj({ target: TARGET, message_ids: s.arr({ type: 'integer' }, 'message_ids to forward, in order'), merged: s.bool('Bundle into one 合并转发 card', { default: true }) }, ['target', 'message_ids']),
    handler: async ({ target, message_ids, merged = true }) => {
      const t = await resolveTarget(target);
      if (merged) {
        const messages = message_ids.map((id: number) => ({ type: 'node', data: { id: String(id) } }));
        const r = await onebot.call('send_forward_msg', t.type === 'group' ? { group_id: t.id, messages } : { user_id: t.id, messages });
        return { sent: true, to: targetLabel(t), result: r };
      }
      const out = [];
      for (const id of message_ids) out.push(await onebot.call(t.type === 'group' ? 'forward_group_single_msg' : 'forward_friend_single_msg', t.type === 'group' ? { group_id: t.id, message_id: id } : { user_id: t.id, message_id: id }));
      return { sent: true, to: targetLabel(t), count: out.length };
    },
  });

  defineTool({
    name: 'send_fake_forward', category: 'chat',
    description: 'Send a 合并转发 card built from custom nodes (each with a display name, QQ number and content), e.g. to share a summary as a chat transcript.',
    inputSchema: s.obj({ target: TARGET, nodes: s.arr(s.obj({ name: s.str('Display name'), uin: s.id('QQ number shown as the avatar'), content: s.str('Text (inline tokens allowed)') }, ['content']), 'Messages in the bundle'), source: s.str('Card title'), summary: s.str('Card footer') }, ['target', 'nodes']),
    handler: async ({ target, nodes, source, summary }) => {
      const t = await resolveTarget(target);
      const me = await onebot.call<any>('get_login_info').catch(() => ({}));
      const messages = nodes.map((n: any) => ({ type: 'node', data: { name: n.name || me.nickname || 'QQ', uin: String(n.uin || me.user_id || 10000), user_id: String(n.uin || me.user_id || 10000), nickname: n.name || me.nickname, content: parseInline(String(n.content)) } }));
      const r = await onebot.call('send_forward_msg', { ...(t.type === 'group' ? { group_id: t.id } : { user_id: t.id }), messages, ...(source ? { source } : {}), ...(summary ? { summary } : {}) });
      return { sent: true, to: targetLabel(t), result: r };
    },
  });

  defineTool({
    name: 'poke', category: 'chat',
    description: '戳一戳 someone: a friend in private chat, or a member inside a group.',
    inputSchema: s.obj({ user_id: s.id('QQ number to poke'), group_id: s.id('Group to poke them in (omit for private poke)') }, ['user_id']),
    handler: async ({ user_id, group_id }) => onebot.call(group_id ? 'group_poke' : 'friend_poke', group_id ? { group_id: Number(group_id), user_id: Number(user_id) } : { user_id: Number(user_id) }),
  });

  defineTool({
    name: 'view_image', category: 'chat', readOnly: true,
    description: 'Look at a picture: pass a message_id (first image in that message), an image URL, a local path, or an image file id. Returns the image so you can see it.',
    inputSchema: s.obj({ message_id: s.int('Message containing the image'), index: s.int('Which image in the message (0-based)', { default: 0 }), url: s.str('Image URL / path / base64'), file: s.str('Image file id from a message segment (get_image)') }),
    handler: async ({ message_id, index = 0, url, file }) => {
      let ref = url as string | undefined;
      if (!ref && message_id) {
        const m = await onebot.call<any>('get_msg', { message_id });
        const imgs = (Array.isArray(m.message) ? m.message : []).filter((x: any) => x.type === 'image' || x.type === 'mface');
        if (!imgs.length) throw new Error('that message has no image');
        const seg = imgs[Math.min(index, imgs.length - 1)].data;
        ref = seg.url || seg.file;
        if (ref && !/^(https?|file|base64):/.test(ref)) { const g = await onebot.call<any>('get_image', { file: ref }); ref = g?.url || g?.file; }
      }
      if (!ref && file) { const g = await onebot.call<any>('get_image', { file }); ref = g?.file && !/^https?:/.test(g.file) ? g.file : g?.url; }
      if (!ref) throw new Error('pass message_id, url or file');
      return { __image: await imageForModel(await loadBytes(ref)) };
    },
  });

  defineTool({
    name: 'download_media', category: 'chat', readOnly: true,
    description: 'Save the image/voice/video/file of a message (or any URL) on the server and return its local path, which other tools (send_file, send_qzone_msg images…) accept.',
    inputSchema: s.obj({ message_id: s.int('Message with the media'), index: s.int('Which media segment (0-based)', { default: 0 }), url: s.str('Or a direct URL'), name: s.str('File name to save as') }),
    handler: async ({ message_id, index = 0, url, name }) => {
      let ref = url as string | undefined; let fname = name as string | undefined;
      if (!ref && message_id) {
        const m = await onebot.call<any>('get_msg', { message_id });
        const segs = (Array.isArray(m.message) ? m.message : []).filter((x: any) => ['image', 'mface', 'record', 'video', 'file'].includes(x.type));
        if (!segs.length) throw new Error('that message has no media');
        const seg = segs[Math.min(index, segs.length - 1)];
        fname = fname || seg.data.name || seg.data.file_name || seg.data.file;
        const action = seg.type === 'record' ? 'get_record' : seg.type === 'file' || seg.type === 'video' ? 'get_file' : 'get_image';
        const params: any = seg.type === 'record' ? { file: seg.data.file, out_format: 'mp3' } : { file: seg.data.file, file_id: seg.data.file_id };
        const g = await onebot.call<any>(action, params, 300_000).catch(() => undefined);
        if (g?.file && !/^https?:/.test(g.file)) return { path: g.file, size: g.file_size ?? g.size, name: g.file_name ?? fname };
        ref = g?.url || seg.data.url;
        if (!ref && m.group_id && seg.type === 'file') ref = (await onebot.call<any>('get_group_file_url', { group_id: m.group_id, file_id: seg.data.file_id }))?.url;
      }
      if (!ref) throw new Error('could not find a download URL; pass url');
      const buf = await loadBytes(ref);
      const p = await saveDownload(buf, fname || decodeURIComponent((/^https?:/.test(ref) ? new URL(ref).pathname.split('/').pop() : ref.split('/').pop()) || 'file'));
      return { path: p, size: buf.length };
    },
  });

  // ---- live events -------------------------------------------------------

  defineTool({
    name: 'list_recent_chats', category: 'events', readOnly: true,
    description: 'Chats with activity since the MCP server started (newest first): last message, unread count (messages you have not read via read_chat/get_unread).',
    inputSchema: s.obj({ limit: s.int('Max chats', { default: 30 }) }),
    handler: async ({ limit = 30 }) => {
      await onebot.ready();
      const chats = new Map<string, { last: any; unread: number; total: number }>();
      for (const e of onebot.events) {
        if (!isMsg(e)) continue;
        const k = eventChatKey(e);
        const c = chats.get(k) ?? { last: e, unread: 0, total: 0 };
        c.last = e; c.total++;
        if (e.user_id !== e.self_id && e._seq > (readUpTo.get(k) ?? 0) && !seen.has(e._seq)) c.unread++;
        chats.set(k, c);
      }
      const names = new Map<string, string>();
      const [fl, gl] = await Promise.all([getFriends().catch(() => []), getGroups().catch(() => [])]);
      for (const f of fl) names.set(`qq:${f.user_id}`, friendName(f));
      for (const g of gl) names.set(`group:${g.group_id}`, g.group_name ?? '');
      return [...chats.entries()].sort((a, b) => b[1].last._seq - a[1].last._seq).slice(0, limit).map(([k, c]) => {
        const m = compactMessage(c.last);
        return { chat: k, name: names.get(k), unread: c.unread, last: `${m.time} ${m.from}: ${m.text.slice(0, 120)}` };
      });
    },
  });

  defineTool({
    name: 'get_unread', category: 'events', readOnly: true,
    description: 'New incoming messages you have not seen yet (since the server started or your last get_unread/read_chat), grouped by chat. Marks them as seen.',
    inputSchema: s.obj({ target: s.str('Only this chat (same forms as other tools)'), mark_seen: s.bool('Mark returned messages as seen', { default: true }), limit: s.int('Max messages', { default: 200 }) }),
    handler: async ({ target, mark_seen = true, limit = 200 }) => {
      await onebot.ready();
      const only = target ? chatKey(await resolveTarget(target)) : undefined;
      const out: Record<string, string[]> = {};
      let n = 0; const top = onebot.latestSeq();
      for (const e of onebot.events) {
        if (!isMsg(e) || e.user_id === e.self_id) continue;
        const k = eventChatKey(e);
        if (only && k !== only) continue;
        if (e._seq <= (readUpTo.get(k) ?? 0) || seen.has(e._seq)) continue;
        if (n++ >= limit) break;
        const c = compactMessage(e);
        (out[k] ??= []).push(`#${c.message_id} ${c.time} ${c.from}: ${c.text}`);
      }
      if (mark_seen) for (const k of only ? [only] : Object.keys(out)) readUpTo.set(k, top);
      return n ? out : 'No unread messages.';
    },
  });

  defineTool({
    name: 'get_events', category: 'events', readOnly: true,
    description: 'Raw live events received from QQ (messages, recalls, pokes, join/leave, friend/group requests, file uploads, etc.), oldest first. Use since = the last seq you saw to get only new ones.',
    inputSchema: s.obj({ since: s.int('Only events with seq greater than this', { default: 0 }), types: s.arr({ type: 'string' }, 'Filter by post_type or post_type.subtype, e.g. ["message","notice.group_recall","request"]'), limit: s.int('Max events (latest kept)', { default: 100 }) }),
    handler: async ({ since = 0, types, limit = 100 }) => {
      await onebot.ready();
      const ok = (e: any) => !types?.length || types.some((t: string) => { const c = compactEvent(e).type; return c === t || c.startsWith(`${t}.`) || e.post_type === t; });
      const list = onebot.events.filter((e) => e._seq > since && ok(e));
      return { latest_seq: onebot.latestSeq(), events: list.slice(-limit).map(compactEvent) };
    },
  });

  defineTool({
    name: 'wait_for_message', category: 'events', readOnly: true,
    description: 'Block until a new message arrives (optionally only from a chat / sender / containing text), up to timeout_seconds. Good for "reply when they answer" flows.',
    inputSchema: s.obj({ target: s.str('Only this chat'), from_user: s.id('Only from this QQ number'), contains: s.str('Only messages containing this text'), include_self: s.bool('Also match my own messages', { default: false }), timeout_seconds: s.int('Max wait (≤ 600)', { default: 120 }) }),
    handler: async ({ target, from_user, contains, include_self = false, timeout_seconds = 120 }) => {
      await onebot.ready();
      const only = target ? chatKey(await resolveTarget(target)) : undefined;
      const e = await onebot.waitFor((ev) => isMsg(ev)
        && (include_self || ev.user_id !== ev.self_id)
        && (!only || eventChatKey(ev) === only)
        && (!from_user || String(ev.user_id) === String(from_user))
        && (!contains || messageText(ev.message, ev.raw_message).includes(String(contains))), Math.min(timeout_seconds, 600) * 1000);
      if (!e) return `No matching message within ${timeout_seconds}s.`;
      seen.add(e._seq);
      return compactMessage(e);
    },
  });

  defineTool({
    name: 'wait_for_event', category: 'events', readOnly: true,
    description: 'Block until an event of the given types arrives (e.g. "notice.group_increase", "request.friend", "notice.group_recall").',
    inputSchema: s.obj({ types: s.arr({ type: 'string' }, 'post_type or post_type.subtype values'), timeout_seconds: s.int('Max wait (≤ 600)', { default: 120 }) }, ['types']),
    handler: async ({ types, timeout_seconds = 120 }) => {
      await onebot.ready();
      const e = await onebot.waitFor((ev) => types.some((t: string) => { const c = compactEvent(ev).type; return c === t || c.startsWith(`${t}.`); }), Math.min(timeout_seconds, 600) * 1000);
      return e ? compactEvent(e) : `No matching event within ${timeout_seconds}s.`;
    },
  });

  defineTool({
    name: 'list_friend_requests', category: 'events', readOnly: true,
    description: 'Pending friend requests and group join/invite requests seen live, plus the group system message box (入群申请/邀请). Approve with set_friend_add_request / set_group_add_request using the flag.',
    inputSchema: s.obj({}),
    handler: async () => {
      const live = onebot.events.filter((e) => e.post_type === 'request').map(compactEvent);
      const sys = await onebot.call('get_group_system_msg').catch((e: Error) => `unavailable: ${e.message}`);
      const doubt = await onebot.call('get_doubt_friends_add_request', { count: 50 }).catch(() => undefined);
      return { live_requests: live, group_system_msg: sys, doubtful_friend_requests: doubt };
    },
  });

  defineTool({
    name: 'onebot_call', category: 'raw',
    description: 'Call any OneBot v11 / extended action of the QQ runtime directly (escape hatch for anything the other tools miss). See list_actions for names.',
    inputSchema: s.obj({ action: s.str('Action name, e.g. "get_group_member_list"'), params: { type: 'object', description: 'Action parameters', additionalProperties: true }, timeout_seconds: s.int('Timeout', { default: 60 }) }, ['action']),
    handler: async ({ action, params = {}, timeout_seconds = 60 }) => onebot.call(String(action), params, timeout_seconds * 1000),
  });
}
