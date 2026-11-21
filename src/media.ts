/* Fetch images/files (QQ CDN URLs, local paths, base64) and shrink images for the model to look at. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { settings } from './config.js';

const run = promisify(execFile);

export function sniffMime(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}

export async function loadBytes(ref: string): Promise<Buffer> {
  const v = ref.trim();
  if (/^https?:\/\//i.test(v)) {
    const r = await fetch(v, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQ/9.9' } });
    if (!r.ok) throw new Error(`download failed: HTTP ${r.status} for ${v.slice(0, 120)}`);
    return Buffer.from(await r.arrayBuffer());
  }
  if (v.startsWith('base64://')) return Buffer.from(v.slice(9), 'base64');
  if (v.startsWith('data:')) return Buffer.from(v.replace(/^data:[^,]*,/, ''), 'base64');
  const p = v.startsWith('file://') ? decodeURIComponent(v.slice(7)) : v;
  return fs.promises.readFile(p);
}

/** Return image bytes small enough to hand to a model (≤ ~1MB, ≤ 1600px), converting odd formats to JPEG. */
export async function imageForModel(buf: Buffer): Promise<{ data: string; mimeType: string }> {
  let mime = sniffMime(buf);
  const ok = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);
  if (ok && buf.length <= 1_000_000) return { data: buf.toString('base64'), mimeType: mime };
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qqimg-'));
  try {
    const src = path.join(dir, 'in'); const dst = path.join(dir, 'out.jpg');
    await fs.promises.writeFile(src, buf);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", '-q:v', '4', dst]);
    const out = await fs.promises.readFile(dst);
    mime = 'image/jpeg';
    return { data: out.toString('base64'), mimeType: mime };
  } catch {
    if (ok) return { data: buf.toString('base64'), mimeType: mime };
    throw new Error(`cannot convert ${mime} image (ffmpeg missing?)`);
  } finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

export async function saveDownload(buf: Buffer, name: string): Promise<string> {
  await fs.promises.mkdir(settings.downloadDir, { recursive: true });
  const safe = name.replace(/[\\/:*?"<>|\0]/g, '_').slice(0, 150) || 'file';
  const p = path.join(settings.downloadDir, `${Date.now()}-${safe}`);
  await fs.promises.writeFile(p, buf);
  return p;
}
