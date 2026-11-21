/* QQ 空间 extras on top of the runtime's qzone actions: visitors, 留言板, personal albums, like lists, forwards, comment deletion… */
import { myUin, qzone, qzoneAuth } from '../qzone/web.js';
import { fmtTime } from '../format.js';
import { loadBytes } from '../media.js';
import { defineTool, s } from './registry.js';

const CS = { inCharset: 'utf-8', outCharset: 'utf-8' };
const UIN = s.id('QQ number whose 空间 to use (default: your own)');
const strip = (h: unknown) => String(h ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
const ref = (host: string | number, page = '') => `https://user.qzone.qq.com/${host}${page}`;

export function registerQzoneTools() {
  defineTool({
    name: 'qzone_visitors', category: 'qzone_web', readOnly: true,
    description: 'QQ空间 访客记录: who visited a 空间 recently (yours by default; others need permission), with time and source.',
    inputSchema: s.obj({ uin: UIN, page: s.int('Page (1-based)', { default: 1 }) }),
    handler: async ({ uin, page = 1 }) => {
      const host = String(uin ?? await myUin());
      const d = await qzone({ url: 'g.qzone.qq.com/cgi-bin/friendshow/cgi_get_visitor_more', query: { uin: host, mask: 7, page, fupdate: 1, clear: 1 } });
      const data = d.data ?? d;
      return {
        today: data.todaycount, total: data.totalcount,
        visitors: (data.items ?? []).map((v: any) => ({ uin: v.uin, name: v.name, time: fmtTime(v.time), source: v.src, ...(v.yellow > 0 ? { vip: v.yellow } : {}), ...(v.hide ? { hidden: true } : {}) })),
      };
    },
  });

  defineTool({
    name: 'qzone_board_list', category: 'qzone_web', readOnly: true,
    description: 'Read a 空间 留言板 (message board) — yours by default — with replies.',
    inputSchema: s.obj({ uin: UIN, start: s.int('Offset', { default: 0 }), num: s.int('How many (max 20)', { default: 10 }) }),
    handler: async ({ uin, start = 0, num = 10 }) => {
      const me = await myUin(); const host = String(uin ?? me);
      const d = await qzone({ url: 'm.qzone.qq.com/cgi-bin/new/get_msgb', query: { uin: me, hostUin: host, num: Math.min(num, 20), start, hostword: 0, essence: 1, r: Math.random(), iNotice: 0, ...CS, format: 'jsonp', ref: 'qzone' } });
      const data = d.data ?? d;
      return {
        total: data.total ?? data.authorInfo?.total,
        messages: (data.commentList ?? []).map((m: any) => ({
          id: m.id, uin: m.uin, name: m.nickname, time: m.pubtime, text: strip(m.htmlContent ?? m.ubbContent),
          ...(m.replyList?.length ? { replies: m.replyList.map((r: any) => ({ uin: r.uin, name: r.nick, time: fmtTime(r.time), text: strip(r.content) })) } : {}),
        })),
      };
    },
  });

  defineTool({
    name: 'qzone_board_post', category: 'qzone_web',
    description: 'Write a message on someone\'s 留言板 (or your own).',
    inputSchema: s.obj({ uin: s.id('Whose 留言板 (QQ number)'), content: s.str('Message text') }, ['uin', 'content']),
    handler: async ({ uin, content }) => {
      const me = await myUin();
      const d = await qzone({ url: 'm.qzone.qq.com/cgi-bin/new/add_msgb', form: { content, hostUin: uin, uin: me, format: 'fs', ...CS, iNotice: 1, ref: 'qzone', json: 1, qzreferrer: ref(uin, '/334') } });
      return { posted: true, id: d.data?.id ?? d.id, result: d.message ?? 'ok' };
    },
  });

  defineTool({
    name: 'qzone_board_reply', category: 'qzone_web',
    description: 'Reply to a message on a 留言板 (usually your own).',
    inputSchema: s.obj({ uin: UIN, message_id: s.str('留言 id from qzone_board_list'), content: s.str('Reply text') }, ['message_id', 'content']),
    handler: async ({ uin, message_id, content }) => {
      const me = await myUin(); const host = String(uin ?? me);
      const d = await qzone({ url: 'm.qzone.qq.com/cgi-bin/new/add_reply', form: { hostUin: host, msgId: message_id, content, uin: me, format: 'fs', ...CS, ref: 'qzone', json: 1, iNotice: 1, qzreferrer: ref(host, '/334') } });
      return { replied: true, result: d.message ?? 'ok' };
    },
  });

  defineTool({
    name: 'qzone_board_delete', category: 'qzone_web', destructive: true,
    description: 'Delete a 留言板 message (on your own board, or one you wrote elsewhere).',
    inputSchema: s.obj({ uin: UIN, message_id: s.str('留言 id'), author_uin: s.id('Who wrote it (from qzone_board_list)') }, ['message_id', 'author_uin']),
    handler: async ({ uin, message_id, author_uin }) => {
      const me = await myUin(); const host = String(uin ?? me);
      await qzone({ url: 'm.qzone.qq.com/cgi-bin/new/del_msgb', form: { hostUin: host, idList: message_id, uinList: author_uin, format: 'fs', ...CS, iNotice: 1, ref: 'qzone', json: 1, qzreferrer: ref(host, '/334') } });
      return { deleted: true };
    },
  });

  defineTool({
    name: 'qzone_albums', category: 'qzone_web', readOnly: true,
    description: 'List personal 空间相册 albums (yours by default) with ids, photo counts and privacy.',
    inputSchema: s.obj({ uin: UIN }),
    handler: async ({ uin }) => {
      const me = await myUin(); const host = String(uin ?? me);
      const d = await qzone({ url: 'photo.qzone.qq.com/fcgi-bin/fcg_list_album_v3', query: { hostUin: host, uin: me, appid: 4, ...CS, source: 'qzone', plat: 'qzone', format: 'jsonp', notice: 0, filter: 1, handset: 4, pageNumModeSort: 40, pageNumModeClass: 15, needUserInfo: 1, idcNum: 4, mode: 2, sortOrder: 1, pageStart: 0, pageNum: 100 } });
      const data = d.data ?? d;
      const list = data.albumListModeSort ?? data.albumList ?? (data.albumListModeClass ?? []).flatMap((c: any) => c.albumList ?? []);
      return { total: data.albumsInUser ?? list.length, albums: list.map((a: any) => ({ id: a.id, name: a.name, desc: a.desc || undefined, photos: a.total, priv: a.priv, created: fmtTime(a.createtime), updated: fmtTime(a.modifytime), cover: a.pre })) };
    },
  });

  defineTool({
    name: 'qzone_album_photos', category: 'qzone_web', readOnly: true,
    description: 'List photos in a personal 空间相册 album (with full-size URLs). Use view_image url=… to look at one.',
    inputSchema: s.obj({ uin: UIN, album_id: s.str('Album id from qzone_albums'), start: s.int('Offset', { default: 0 }), num: s.int('How many (max 100)', { default: 30 }) }, ['album_id']),
    handler: async ({ uin, album_id, start = 0, num = 30 }) => {
      const me = await myUin(); const host = String(uin ?? me);
      const d = await qzone({ url: 'photo.qzone.qq.com/fcgi-bin/cgi_list_photo', query: { mode: 0, idcNum: 4, hostUin: host, topicId: album_id, noTopic: 0, uin: me, pageStart: start, pageNum: Math.min(num, 100), skipCmtCount: 0, singleurl: 1, batchId: '', notice: 0, appid: 4, ...CS, source: 'qzone', plat: 'qzone', outstyle: 'json', format: 'jsonp', json_esc: 1 } });
      const data = d.data ?? d;
      return {
        album: data.topic?.name, total: data.totalInAlbum ?? data.topic?.total,
        photos: (data.photoList ?? []).map((p: any) => ({ id: p.lloc, name: p.name || undefined, desc: p.desc || undefined, time: p.uploadtime, url: p.raw || p.origin_url || p.url, width: p.width, height: p.height, ...(p.is_video ? { video: true } : {}) })),
      };
    },
  });

  defineTool({
    name: 'qzone_create_album', category: 'qzone_web',
    description: 'Create a personal 空间相册 album.',
    inputSchema: s.obj({ name: s.str('Album name'), desc: s.str('Description'), priv: s.int('Privacy: 1 all, 3 only me, 4 friends, 5 Q&A, 6 selected friends', { default: 1 }) }, ['name']),
    handler: async ({ name, desc = '', priv = 1 }) => {
      const me = await myUin();
      const d = await qzone({ url: 'photo.qzone.qq.com/cgi-bin/common/cgi_add_album_v2', form: { ...CS, hostUin: me, notice: 0, callbackFun: '_Callback', format: 'fs', plat: 'qzone', source: 'qzone', appid: 4, uin: me, albumname: name, albumdesc: desc, albumclass: 100, priv, question: '', answer: '', whiteList: '', bitmap: '10000000', qzreferrer: ref(me, '/infocenter') } });
      const data = d.data ?? d;
      let id = data.id ?? data.albumid;
      if (!id) { // the CGI does not always echo the id: look it up
        const l = await qzone({ url: 'photo.qzone.qq.com/fcgi-bin/fcg_list_album_v3', query: { hostUin: me, uin: me, appid: 4, ...CS, source: 'qzone', plat: 'qzone', format: 'jsonp', notice: 0, filter: 1, handset: 4, pageNumModeSort: 40, pageNumModeClass: 15, needUserInfo: 1, idcNum: 4, mode: 2, sortOrder: 1, pageStart: 0, pageNum: 100 } }).catch(() => undefined);
        const list = l?.data?.albumListModeSort ?? l?.data?.albumList ?? [];
        id = list.filter((a: any) => a.name === name).sort((a: any, b: any) => (b.createtime ?? 0) - (a.createtime ?? 0))[0]?.id;
      }
      return { created: true, id, name };
    },
  });


  defineTool({
    name: 'qzone_upload_photo', category: 'qzone_web',
    description: 'Upload a picture (URL, server path or base64) into one of your 空间相册 albums.',
    inputSchema: s.obj({ album_id: s.str('Target album id'), image: s.str('URL / path / base64'), desc: s.str('Photo description') }, ['album_id', 'image']),
    handler: async ({ album_id, image, desc = '' }) => {
      const a = await qzoneAuth();
      const jar = Object.fromEntries(a.cookie.split(/;\s*/).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
      const b64 = (await loadBytes(image)).toString('base64');
      const d = await qzone({
        url: 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image',
        form: {
          filename: 'filename', zzpanelkey: '', uploadtype: '1', albumtype: '1', exttype: '0', skey: jar.skey, zzpaneluin: a.uin, p_uin: a.uin, uin: a.uin, p_skey: jar.p_skey,
          output_type: 'jsonhtml', qzonetoken: '', refer: 'album', charset: 'utf-8', output_charset: 'utf-8', upload_hd: '1', hd_width: '2048', hd_height: '10000', hd_quality: '96',
          backUrls: 'http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image', url: `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${a.gtk}`,
          base64: '1', jsonhtml_callback: 'callback', picfile: b64, albumid: album_id, desc, qzreferrer: ref(a.uin, '/main'),
        },
      });
      const data = d.data ?? d;
      if (!data.lloc && !data.url) throw new Error(`upload failed: ${JSON.stringify(d).slice(0, 300)}`);
      return { uploaded: true, album_id: data.albumid ?? album_id, photo_id: data.lloc, url: data.url, width: data.width, height: data.height };
    },
  });


  defineTool({
    name: 'qzone_like_list', category: 'qzone_web', readOnly: true,
    description: 'Who liked a 说说 (names and QQ numbers).',
    inputSchema: s.obj({ uin: s.id('Author of the 说说 (default: you)'), tid: s.str('说说 tid'), count: s.int('Max likers', { default: 60 }) }, ['tid']),
    handler: async ({ uin, tid, count = 60 }) => {
      const me = await myUin(); const host = String(uin ?? me);
      const d = await qzone({ url: 'users.qzone.qq.com/cgi-bin/likes/get_like_list_app', query: { uin: me, unikey: `http://user.qzone.qq.com/${host}/mood/${tid}`, begin_uin: 0, query_count: count, if_first_page: 1 } });
      const data = d.data ?? d;
      return { total: data.total_number, likers: (data.like_uin_info ?? []).map((l: any) => ({ uin: l.fuin, name: l.nick, ...(l.if_qq_friend ? { friend: true } : {}) })) };
    },
  });

  defineTool({
    name: 'qzone_post_counts', category: 'qzone_web', readOnly: true,
    description: 'View / like / comment / forward counts of a 说说.',
    inputSchema: s.obj({ uin: s.id('Author (default: you)'), tid: s.str('说说 tid') }, ['tid']),
    handler: async ({ uin, tid }) => {
      const host = String(uin ?? await myUin());
      const key = `http://user.qzone.qq.com/${host}/mood/${tid}`;
      const d = await qzone({ url: 'r.qzone.qq.com/cgi-bin/user/qz_opcnt2', query: { _stp: Date.now(), unikey: `${key}.1<.>${key}`, face: 0, fupdate: 1 } });
      const c = (d.data ?? [])[0]?.current ?? {};
      return { views: c.newdata?.PRD, likes: c.likedata?.cnt, comments: c.newdata?.CS, forwards: c.newdata?.ZS, liked_by_me: c.likedata?.ilike === 1 };
    },
  });

  defineTool({
    name: 'qzone_delete_comment', category: 'qzone_web', destructive: true,
    description: 'Delete a comment under a 说说 (any comment on your own 说说, or your own comment elsewhere).',
    inputSchema: s.obj({ uin: s.id('Author of the 说说 (default: you)'), tid: s.str('说说 tid'), comment_id: s.str('Comment id (from get_qzone_msg_detail)'), comment_uin: s.id('Who wrote the comment') }, ['tid', 'comment_id', 'comment_uin']),
    handler: async ({ uin, tid, comment_id, comment_uin }) => {
      const me = await myUin(); const host = String(uin ?? me);
      await qzone({ url: 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_delcomment_ugc', form: { uin: me, hostUin: host, topicId: `${host}_${tid}__1`, commentId: comment_id, commentUin: comment_uin, ...CS, ref: '', format: 'fs', qzreferrer: ref(host) } });
      return { deleted: true };
    },
  });

  defineTool({
    name: 'qzone_forward', category: 'qzone_web',
    description: '转发 a 说说 to your own 空间, with an optional comment.',
    inputSchema: s.obj({ uin: s.id('Author of the 说说'), tid: s.str('说说 tid'), content: s.str('Your comment on the forward', { default: '' }) }, ['uin', 'tid']),
    handler: async ({ uin, tid, content = '' }) => {
      const me = await myUin();
      const d = await qzone({ url: 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_forward_v6', form: { tid, t1_source: 1, t1_uin: uin, signin: 0, con: content, with_cmt: 0, fwdToWeibo: 0, forward_source: 2, code_version: 1, format: 'fs', out_charset: 'UTF-8', hostuin: me, qzreferrer: ref(me) } });
      return { forwarded: true, tid: d.tid ?? d.data?.tid };
    },
  });

  defineTool({
    name: 'qzone_friends', category: 'qzone_web', readOnly: true,
    description: 'Friends as QQ空间 sees them, with 空间 grouping and 亲密度 (intimacy score).',
    inputSchema: s.obj({}),
    handler: async () => {
      const me = await myUin();
      const d = await qzone({ url: 'r.qzone.qq.com/cgi-bin/tfriend/friend_show_qqfriends.cgi', query: { uin: me, follow_flag: 1, groupface_flag: 0, fupdate: 1 } });
      const data = d.data ?? d;
      const groups = Object.fromEntries((data.gpnames ?? []).map((g: any) => [g.gpid, g.gpname]));
      return (data.items ?? []).map((f: any) => ({ uin: f.uin, name: f.remark || f.name, ...(f.remark ? { nickname: f.name } : {}), group: groups[f.groupid], intimacy: f.score, ...(f.specialflag === '1' ? { special_care: true } : {}) }));
    },
  });

  defineTool({
    name: 'qzone_intimacy', category: 'qzone_web', readOnly: true,
    description: '空间 friendship ranking: who you care about most (mine) or who cares about you most (theirs), by 亲密度.',
    inputSchema: s.obj({ direction: s.enum(['mine', 'theirs'], 'mine = 我在意谁, theirs = 谁在意我', { default: 'mine' }) }),
    handler: async ({ direction = 'mine' }) => {
      const me = await myUin();
      const d = await qzone({ url: 'r.qzone.qq.com/cgi-bin/tfriend/friend_ship_manager.cgi', query: { uin: me, do: direction === 'mine' ? 1 : 2, rd: Math.random(), fupdate: 1, clean: 1 } });
      const data = d.data ?? d;
      return (data.items_list ?? data.items ?? []).map((f: any) => ({ uin: f.uin, name: f.name, score: f.score }));
    },
  });

  defineTool({
    name: 'qzone_user_card', category: 'qzone_web', readOnly: true,
    description: 'Someone\'s 空间 name card (nickname, avatar, 空间 name, whether you can visit, etc.).',
    inputSchema: s.obj({ uin: s.id('QQ number') }, ['uin']),
    handler: async ({ uin }) => qzone({ url: 'r.qzone.qq.com/cgi-bin/user/cgi_personal_card', query: { uin, fupdate: 1 } }),
  });

  defineTool({
    name: 'qzone_request', category: 'qzone_web',
    description: 'Call any QQ空间 web CGI with your logged-in cookies and g_tk added automatically (escape hatch). url: full https URL, or "host/path" sent via the h5.qzone.qq.com proxy, e.g. "taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6". Parses JSON/JSONP/frameElement.callback responses.',
    inputSchema: s.obj({ url: s.str('URL or host/path'), method: s.enum(['GET', 'POST'], 'HTTP method (POST when form is given)'), query: { type: 'object', description: 'Query parameters', additionalProperties: true }, form: { type: 'object', description: 'x-www-form-urlencoded body', additionalProperties: true } }, ['url']),
    handler: async ({ url, method, query, form }) => qzone({ url, method, query, form }),
  });
}
