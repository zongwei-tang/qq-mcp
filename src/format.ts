/* Turn OneBot message events into compact, readable records. */

export type Segment = { type: string; data: Record<string, any> };

const fmtTime = (t?: number) => {
  if (!t) return undefined;
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  // shown in China time: QQ users think in it
  const c = new Date(d.getTime() + 8 * 3600_000);
  return `${c.getUTCFullYear()}-${p(c.getUTCMonth() + 1)}-${p(c.getUTCDate())} ${p(c.getUTCHours())}:${p(c.getUTCMinutes())}:${p(c.getUTCSeconds())}`;
};
export { fmtTime };

function cardTitle(raw: any): string {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return j?.prompt || j?.meta?.detail_1?.title || j?.meta?.news?.title || j?.app || 'card';
  } catch { return 'card'; }
}

export function segmentText(seg: Segment): string {
  const d = seg.data ?? {};
  switch (seg.type) {
    case 'text': return d.text ?? '';
    case 'at': return d.qq === 'all' ? '@全体成员' : `@${d.name || d.qq}`;
    case 'face': return `[表情${d.id ?? ''}]`;
    case 'mface': return `[${d.summary || '表情包'}]`;
    case 'image': return `[图片${d.summary && d.summary !== '[图片]' ? ` ${d.summary}` : ''} ${d.url || d.file || ''}]`.replace(/\s+]/, ']');
    case 'record': return `[语音${d.file ? ` ${d.file}` : ''}]`;
    case 'video': return `[视频 ${d.url || d.file || ''}]`;
    case 'file': return `[文件 ${d.name || d.file || ''}${d.file_size ? ` ${d.file_size}B` : ''}${d.file_id ? ` file_id=${d.file_id}` : ''}]`;
    case 'reply': return `[回复#${d.id}]`;
    case 'forward': return `[合并转发 id=${d.id}]`;
    case 'json': return `[卡片 ${cardTitle(d.data)}]`;
    case 'xml': return '[XML卡片]';
    case 'poke': return '[戳一戳]';
    case 'dice': return `[骰子${d.result ? ` ${d.result}` : ''}]`;
    case 'rps': return `[猜拳${d.result ? ` ${d.result}` : ''}]`;
    case 'markdown': return `[markdown] ${d.content ?? ''}`;
    case 'share': return `[分享 ${d.title || ''} ${d.url || ''}]`;
    case 'location': return `[位置 ${d.title || ''} ${d.lat},${d.lon}]`;
    case 'music': return `[音乐 ${d.title || d.id || ''}]`;
    case 'contact': return `[推荐${d.type === 'group' ? '群' : '好友'} ${d.id}]`;
    default: return `[${seg.type}]`;
  }
}

export function messageText(message: unknown, raw?: string): string {
  if (Array.isArray(message)) return message.map((s) => segmentText(s as Segment)).join('');
  if (typeof message === 'string') return message;
  return raw ?? '';
}

/** Compact record for one message event. */
export function compactMessage(e: any) {
  const sender = e.sender ?? {};
  const name = sender.card || sender.nickname || e.user_id;
  return {
    message_id: e.message_id,
    time: fmtTime(e.time),
    chat: e.group_id ? `group:${e.group_id}` : `qq:${e.message_type === 'private' && e.target_id ? e.target_id : e.user_id}`,
    ...(e.group_id ? { group: e.group_name ? `${e.group_name}(${e.group_id})` : e.group_id } : {}),
    from: `${name}(${e.user_id})`,
    ...(e.self_id && e.user_id === e.self_id ? { self: true } : {}),
    text: messageText(e.message, e.raw_message),
  };
}

/** Compact record for any non-message event (notice/request/meta). */
export function compactEvent(e: any) {
  if (e.post_type === 'message' || e.post_type === 'message_sent') return { seq: e._seq, type: e.post_type, ...compactMessage(e) };
  const { _seq, post_type, time, self_id, ...rest } = e;
  return { seq: _seq, type: `${post_type}${e.notice_type ? `.${e.notice_type}` : e.request_type ? `.${e.request_type}` : e.meta_event_type ? `.${e.meta_event_type}` : ''}`, time: fmtTime(time), ...rest };
}

/** Accept plain text with CQ-ish inline tokens: [@123], [@all], [face:14], [reply:msgid], [image:url-or-path]. */
export function parseInline(text: string): Segment[] {
  const segs: Segment[] = [];
  const re = /\[(@all|@\d+|face:\d+|reply:-?\d+|image:[^\]]+)\]/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    if (m.index > last) segs.push({ type: 'text', data: { text: text.slice(last, m.index) } });
    const tok = m[1];
    if (tok === '@all') segs.push({ type: 'at', data: { qq: 'all' } });
    else if (tok.startsWith('@')) segs.push({ type: 'at', data: { qq: tok.slice(1) } });
    else if (tok.startsWith('face:')) segs.push({ type: 'face', data: { id: tok.slice(5) } });
    else if (tok.startsWith('reply:')) segs.push({ type: 'reply', data: { id: tok.slice(6) } });
    else if (tok.startsWith('image:')) segs.push({ type: 'image', data: { file: fileRef(tok.slice(6).trim()) } });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: 'text', data: { text: text.slice(last) } });
  return segs;
}

/** Normalise a file reference for OneBot: local path → file://, keep http(s)/base64/file:// as-is. */
export function fileRef(f: string): string {
  const v = f.trim();
  if (/^(https?|file|base64):\/\//i.test(v)) return v;
  if (v.startsWith('data:')) return `base64://${v.replace(/^data:[^,]*,/, '')}`;
  if (v.startsWith('/')) return `file://${v}`;
  if (/^[A-Za-z0-9+/=\s]{200,}$/.test(v)) return `base64://${v.replace(/\s+/g, '')}`;
  return v;
}
