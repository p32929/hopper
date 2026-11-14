/**
 * File Manager Server
 *
 * A zero-dependency file manager for any machine that can run Node.js.
 * Browse folders, upload (chunked, resumable), download, ZIP, rename,
 * create folders and delete. Everything is plain Node: no npm install.
 *
 *   PORT       port to listen on            (default 3999)
 *   HOST       address to listen on         (default 0.0.0.0)
 *   FM_ROOT    lock the manager to a folder (default: whole machine)
 *   FM_PASSWORD  ask for this password before showing anything (or: --password=...)
 *   FM_TRUST_PROXY=1  behind a reverse proxy: take the visitor's address from X-Forwarded-For
 *
 * Without a password there is NO login. Run it only on a network you trust.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = require('./package.json').version;
const ROOT = process.env.FM_ROOT ? path.resolve(process.env.FM_ROOT) : null;
const HOME = ROOT || os.homedir();

function passwordFromArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--password=')) return args[i].slice('--password='.length);
    if (args[i] === '--password') return args[i + 1] || '';
  }
  return undefined;
}
const PASSWORD = passwordFromArgs() ?? process.env.FM_PASSWORD ?? '';
const TRUST_PROXY = Boolean(process.env.FM_TRUST_PROXY);
const MAX_WRONG = 5;
const BLOCK_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** Turn a user-supplied path into an absolute path, and keep it inside FM_ROOT. */
function resolvePath(input) {
  let p = input === undefined || input === null || input === '' ? HOME : String(input);
  if (p.includes('\0')) throw new HttpError(400, 'Invalid path');
  if (!path.isAbsolute(p)) throw new HttpError(400, 'Path must be absolute');
  p = path.resolve(p);
  if (ROOT) {
    const inside = (a, b) => a === b || a.startsWith(b + path.sep);
    if (!inside(p, ROOT)) throw new HttpError(403, 'Outside the allowed folder');
    // A symlink inside the root must not lead out of it
    let real = p;
    while (real !== path.dirname(real)) {
      try { real = fs.realpathSync(real); break; } catch { real = path.dirname(real); }
    }
    if (!inside(real, fs.realpathSync(ROOT))) throw new HttpError(403, 'Outside the allowed folder');
  }
  return p;
}

/** A single file or folder name: no slashes, no dots-only, no NUL. */
function cleanName(name) {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..' || /[\\/\0]/.test(n) || n.length > 255) {
    throw new HttpError(400, 'Invalid name');
  }
  return n;
}

/** A relative path such as "photos/2024/a.jpg" (folder uploads). Never escapes. */
function cleanRelative(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length) throw new HttpError(400, 'Missing file name');
  return parts.map(cleanName);
}

function fsError(err) {
  if (err instanceof HttpError) return err;
  if (err.code === 'ENOENT') return new HttpError(404, 'Not found');
  if (err.code === 'EACCES' || err.code === 'EPERM') return new HttpError(403, 'Permission denied');
  if (err.code === 'EEXIST') return new HttpError(409, 'Already exists');
  if (err.code === 'ENOSPC') return new HttpError(507, 'No space left on the device');
  if (err.code === 'ENOTEMPTY') return new HttpError(409, 'Folder is not empty');
  return err;
}

async function uniquePath(target) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let candidate = target;
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

const PART_RE = /\.[\w-]{6,40}\.part$/;

// ---------------------------------------------------------------------------
// File types and MIME
// ---------------------------------------------------------------------------

const KINDS = {
  image: 'jpg jpeg png gif webp svg bmp ico tiff avif heic',
  video: 'mp4 mov mkv webm avi wmv flv m4v',
  audio: 'mp3 wav ogg flac aac m4a opus',
  archive: 'zip rar 7z tar gz bz2 xz tgz',
  document: 'pdf doc docx xls xlsx ppt pptx txt rtf csv tsv md markdown odt ods log tex srt vtt',
  code: 'js mjs cjs ts tsx jsx json jsonc html htm css scss sass less py java kt kts swift c cpp cc h hpp cs rb go rs php sh bash zsh fish bat ps1 yml yaml toml xml sql lua r dart vue svelte astro graphql gql proto tf gradle ini cfg conf env properties diff patch',
};
const KIND_BY_EXT = {};
for (const [kind, list] of Object.entries(KINDS)) for (const e of list.split(' ')) KIND_BY_EXT[e] = kind;

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg',
  pdf: 'application/pdf',
};

function extOf(name) {
  return path.extname(name).slice(1).toLowerCase();
}

// Files the browser can show instead of downloading
const TEXT_EXT = new Set(`${KINDS.code} txt md markdown csv tsv log tex srt vtt lock`.split(' '));
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'procfile', 'gemfile', 'rakefile', 'cmakelists.txt']);
const SHOW_IMAGE = new Set('png jpg jpeg gif webp svg bmp ico avif'.split(' '));
const SHOW_VIDEO = new Set('mp4 m4v webm mov ogv'.split(' '));
const SHOW_AUDIO = new Set('mp3 wav ogg flac m4a aac opus'.split(' '));
const TEXT_MIME = 'text/plain; charset=utf-8';

/** What the page should do when a file is opened: image, video, audio, pdf, text, maybe (check the content) or null (download). */
function previewKind(name) {
  const ext = extOf(name);
  if (SHOW_IMAGE.has(ext)) return 'image';
  if (SHOW_VIDEO.has(ext)) return 'video';
  if (SHOW_AUDIO.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(name.toLowerCase())) return 'text';
  if (!ext || !KIND_BY_EXT[ext]) return 'maybe'; // no or unknown extension: look inside
  return null;
}

/** True when the start of the file is valid UTF-8 text (no NUL bytes). */
async function looksLikeText(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.includes(0)) return false;
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); // a cut-off last character is fine
    return true;
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// API: info, list
// ---------------------------------------------------------------------------

async function apiInfo() {
  const places = [{ name: 'Home', path: HOME, icon: 'home' }];
  if (ROOT) {
    places[0].name = 'Root folder';
  } else {
    for (const [name, icon] of [['Desktop', 'monitor'], ['Documents', 'file-text'], ['Downloads', 'download'],
      ['Pictures', 'image'], ['Music', 'music'], ['Videos', 'video']]) {
      const p = path.join(HOME, name);
      if (fs.existsSync(p)) places.push({ name, path: p, icon });
    }
    if (process.platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const p = `${letter}:\\`;
        if (fs.existsSync(p)) places.push({ name: `Drive ${letter}:`, path: p, icon: 'hard-drive' });
      }
    } else {
      places.push({ name: 'Computer', path: '/', icon: 'hard-drive' });
    }
  }
  return { version: VERSION, hostname: os.hostname(), platform: process.platform, sep: path.sep, home: HOME, root: ROOT, auth: Boolean(PASSWORD), places };
}

async function apiList(query) {
  const abs = resolvePath(query.path);
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw new HttpError(400, 'Not a folder');
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.filter((d) => !PART_RE.test(d.name)).map(async (d) => {
      const full = path.join(abs, d.name);
      try {
        const s = await fsp.stat(full);
        const isDir = s.isDirectory();
        const ext = isDir ? '' : extOf(d.name);
        return {
          name: d.name,
          type: isDir ? 'dir' : 'file',
          size: isDir ? null : s.size,
          modified: s.mtimeMs,
          ext,
          kind: isDir ? 'folder' : KIND_BY_EXT[ext] || 'other',
          preview: isDir ? null : previewKind(d.name),
        };
      } catch {
        return { name: d.name, type: 'file', size: null, modified: null, ext: extOf(d.name), kind: 'other', preview: null, broken: true };
      }
    }),
  );
  const atTop = path.dirname(abs) === abs || (ROOT && abs === ROOT);
  return { path: abs, parent: atTop ? null : path.dirname(abs), sep: path.sep, entries };
}

// ---------------------------------------------------------------------------
// API: mkdir, rename, delete
// ---------------------------------------------------------------------------

async function apiMkdir(req) {
  const body = await readJson(req);
  const dir = resolvePath(body.path);
  if (body.parents) { // "a/b/c": create the whole chain, fine if it already exists (used for empty folders in a folder upload)
    const target = path.join(dir, ...cleanRelative(body.name));
    await fsp.mkdir(target, { recursive: true });
    return { ok: true, path: target };
  }
  const target = path.join(dir, cleanName(body.name));
  await fsp.mkdir(target);
  return { ok: true, path: target };
}

async function apiRename(req) {
  const body = await readJson(req);
  const from = resolvePath(body.path);
  const to = path.join(path.dirname(from), cleanName(body.newName));
  if (from === to) return { ok: true, path: to };
  if (fs.existsSync(to)) throw new HttpError(409, 'Something with that name already exists');
  await fsp.rename(from, to);
  return { ok: true, path: to };
}

async function apiDelete(req) {
  const body = await readJson(req);
  const list = Array.isArray(body.paths) ? body.paths : [];
  if (!list.length) throw new HttpError(400, 'Nothing to delete');
  const targets = list.map(resolvePath);
  for (const t of targets) {
    if (path.dirname(t) === t || t === HOME || t === ROOT) throw new HttpError(403, 'This folder cannot be deleted');
  }
  for (const t of targets) await fsp.rm(t, { recursive: true });
  return { ok: true, deleted: targets.length };
}

// ---------------------------------------------------------------------------
// API: download (with Range support) and ZIP
// ---------------------------------------------------------------------------

function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function apiDownload(req, res, query) {
  const abs = resolvePath(query.path);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new HttpError(400, 'Not a file');
  const name = path.basename(abs);
  const ext = extOf(name);
  const kind = previewKind(name);
  let mime = MIME[ext] || (kind === 'text' ? TEXT_MIME : null);
  if (!mime && kind === 'maybe' && query.inline === '1' && (await looksLikeText(abs))) mime = TEXT_MIME;
  const inline = query.inline === '1' && Boolean(mime);

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1] === '') {
      start = Math.max(0, st.size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
  }

  const headers = {
    'Content-Type': inline ? mime : 'application/octet-stream',
    'Content-Length': st.size === 0 ? 0 : end - start + 1,
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };
  if (ext !== 'pdf') headers['Content-Security-Policy'] = 'sandbox'; // keeps SVG and friends from running scripts
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(status, headers);
  if (st.size === 0) return res.end();
  await pipeline(fs.createReadStream(abs, { start, end }), res).catch(() => {});
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crcSlow(buf, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const crc32 = zlib.crc32 || crcSlow; // Node 22+ has a much faster built-in

function dosDateTime(ms) {
  const d = new Date(ms);
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Files that are already compressed are stored as they are: faster, and no gain from deflating them.
const STORE_EXT = new Set(`zip gz tgz bz2 xz 7z rar zst jpg jpeg png gif webp heic avif mp4 m4v mov mkv webm avi wmv mp3 m4a aac ogg opus flac docx xlsx pptx odt ods apk jar`.split(' '));
// ZIP's classic limits are 4 GB per file / per archive offset and 65,535 entries. Past them, ZIP64 headers are used.
// FM_TEST_ZIP64=1 shrinks the limits so the tests can cover ZIP64 without making multi-GB files.
const TEST_ZIP64 = Boolean(process.env.FM_TEST_ZIP64);
const ZIP64_AT = TEST_ZIP64 ? 1000 : 0xf0000000; // a file this big gets ZIP64 headers
const Z32 = TEST_ZIP64 ? 3000 : 0xffffffff;
const Z16 = TEST_ZIP64 ? 5 : 0xffff;

/** Walk the chosen files and folders into a flat list of ZIP entries. Symlinked folders are skipped (they can loop). */
async function collectZipItems(paths) {
  const items = [];
  let bytes = 0;
  async function walk(abs, rel, top) {
    const link = top ? null : await fsp.lstat(abs);
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      if (link && link.isSymbolicLink()) return;
      items.push({ abs, rel, dir: true, mtime: st.mtimeMs, size: 0 });
      for (const child of await fsp.readdir(abs)) {
        if (PART_RE.test(child)) continue;
        await walk(path.join(abs, child), `${rel}/${child}`, false).catch(() => {}); // unreadable items are skipped
      }
    } else if (st.isFile()) {
      items.push({ abs, rel, dir: false, mtime: st.mtimeMs, size: st.size });
      bytes += st.size;
    }
  }
  for (const p of paths) await walk(p, path.basename(p), true);
  return { items, bytes };
}

function zip64Extra(values) {
  const b = Buffer.alloc(4 + values.length * 8);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return b;
}

/** "Info-ZIP Unicode Path" extra field: lets unzip tools that ignore the UTF-8 flag still get the right name. */
function unicodePathExtra(name) {
  if (!name.some((c) => c > 0x7e)) return Buffer.alloc(0); // plain ASCII needs no help
  const b = Buffer.alloc(4 + 5 + name.length);
  b.writeUInt16LE(0x7075, 0);
  b.writeUInt16LE(5 + name.length, 2);
  b.writeUInt8(1, 4);
  b.writeUInt32LE(crc32(name), 5);
  name.copy(b, 9);
  return b;
}

class ClientGone extends Error {}

async function streamZip(res, items) {
  let offset = 0;
  const central = [];

  const write = (buf) => {
    offset += buf.length;
    if (res.destroyed || res.writableEnded) throw new ClientGone('client left');
    if (res.write(buf)) return null;
    return new Promise((resolve, reject) => {
      const done = () => { res.off('drain', ok); res.off('close', gone); };
      const ok = () => { done(); resolve(); };
      const gone = () => { done(); reject(new ClientGone('client left')); };
      res.once('drain', ok);
      res.once('close', gone);
    });
  };

  for (const it of items) {
    const name = Buffer.from(it.rel + (it.dir ? '/' : ''), 'utf8');
    const ext = extOf(it.rel);
    const big = !it.dir && it.size >= ZIP64_AT;
    const method = it.dir || STORE_EXT.has(ext) ? 0 : 8;
    const { time, date } = dosDateTime(it.mtime);
    const flags = it.dir ? 0x0800 : 0x0808; // UTF-8 names; for files the sizes follow the data
    const uni = unicodePathExtra(name);
    const localExtra = Buffer.concat([uni, big ? zip64Extra([0, 0]) : Buffer.alloc(0)]);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(big ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    if (big) { local.writeUInt32LE(0xffffffff, 18); local.writeUInt32LE(0xffffffff, 22); }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const localOffset = offset;
    await write(Buffer.concat([local, name, localExtra]));

    let crc = 0;
    let usize = 0;
    let csize = 0;
    if (!it.dir) {
      const source = fs.createReadStream(it.abs);
      const deflate = method === 8 ? zlib.createDeflateRaw() : null;
      source.on('data', (c) => { crc = crc32(c, crc); usize += c.length; });
      let out = source;
      if (deflate) { source.on('error', (e) => deflate.destroy(e)); source.pipe(deflate); out = deflate; }
      try {
        for await (const c of out) {
          csize += c.length;
          await write(c);
        }
      } finally {
        source.destroy();
        deflate?.destroy();
      }
      if (!big && (usize >= 0xffffffff || csize >= 0xffffffff)) throw new Error(`"${it.rel}" grew past 4 GB while it was being zipped`);
      const desc = Buffer.alloc(big ? 24 : 16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc, 4);
      if (big) { desc.writeBigUInt64LE(BigInt(csize), 8); desc.writeBigUInt64LE(BigInt(usize), 16); }
      else { desc.writeUInt32LE(csize, 8); desc.writeUInt32LE(usize, 12); }
      await write(desc);
    }
    central.push({ name, uni, flags, method, time, date, crc, csize, usize, localOffset, dir: it.dir, big });
  }

  const cdStart = offset;
  for (const c of central) {
    const bigOffset = c.localOffset >= Z32;
    const z = [];
    if (c.big) z.push(c.usize, c.csize);
    if (bigOffset) z.push(c.localOffset);
    const extra = Buffer.concat([c.uni, z.length ? zip64Extra(z) : Buffer.alloc(0)]);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(c.big || bigOffset ? 45 : 20, 4);
    h.writeUInt16LE(c.big || bigOffset ? 45 : 20, 6);
    h.writeUInt16LE(c.flags, 8);
    h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(c.time, 12);
    h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.big ? 0xffffffff : c.csize, 20);
    h.writeUInt32LE(c.big ? 0xffffffff : c.usize, 24);
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt32LE(c.dir ? 0x10 : 0, 38);
    h.writeUInt32LE(bigOffset ? 0xffffffff : c.localOffset, 42);
    await write(Buffer.concat([h, c.name, extra]));
  }
  const cdSize = offset - cdStart;
  const count = central.length;
  const needZip64 = count >= Z16 || cdStart >= Z32 || cdSize >= Z32;
  if (needZip64) {
    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(0x06064b50, 0);
    eocd64.writeBigUInt64LE(44n, 4);
    eocd64.writeUInt16LE(45, 12);
    eocd64.writeUInt16LE(45, 14);
    eocd64.writeBigUInt64LE(BigInt(count), 24);
    eocd64.writeBigUInt64LE(BigInt(count), 32);
    eocd64.writeBigUInt64LE(BigInt(cdSize), 40);
    eocd64.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset), 8); // where the ZIP64 end record starts
    loc.writeUInt32LE(1, 16);
    await write(Buffer.concat([eocd64, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(needZip64 ? 0xffff : count, 8);
  end.writeUInt16LE(needZip64 ? 0xffff : count, 10);
  end.writeUInt32LE(needZip64 ? 0xffffffff : cdSize, 12);
  end.writeUInt32LE(needZip64 ? 0xffffffff : cdStart, 16);
  await write(end);
  res.end();
}

function zipNameFor(paths) {
  return paths.length === 1 ? `${path.basename(paths[0])}.zip` : `files-${new Date().toISOString().slice(0, 10)}.zip`;
}

async function sendZip(res, plan) {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition('attachment', plan.name),
    'Cache-Control': 'no-store',
  });
  try {
    await streamZip(res, plan.items);
  } catch (err) {
    if (!(err instanceof ClientGone)) console.error('ZIP failed:', err.message);
    res.destroy(); // a cut-off download is better than a ZIP that looks complete but is not
  }
}

// Step 1: the page asks for a ZIP of some paths. We check them here (so a problem shows as a message, not a broken download)
// and hand back a one-time link.
const zipPlans = new Map(); // token -> { items, name, expires }

async function apiZipPlan(req) {
  const body = await readJson(req);
  const list = Array.isArray(body.paths) ? body.paths : [];
  if (!list.length) throw new HttpError(400, 'Nothing selected');
  const paths = list.map(resolvePath);
  const { items, bytes } = await collectZipItems(paths);
  if (!items.length) throw new HttpError(400, 'There are no files to download');
  const token = crypto.randomBytes(16).toString('hex');
  zipPlans.set(token, { items, name: zipNameFor(paths), expires: Date.now() + 2 * 60 * 1000 });
  return { token, files: items.filter((i) => !i.dir).length, folders: items.filter((i) => i.dir).length, bytes };
}

async function apiZipGet(res, query) {
  const plan = zipPlans.get(String(query.token || ''));
  zipPlans.delete(String(query.token || ''));
  if (!plan || plan.expires < Date.now()) throw new HttpError(410, 'This download link has expired. Please try again.');
  await sendZip(res, plan);
}

// Older style: one POST that streams the ZIP straight back (used by simple clients and the tests)
async function apiZip(req, res) {
  const type = req.headers['content-type'] || '';
  let list;
  if (type.startsWith('application/json')) {
    list = (await readJson(req)).paths;
  } else {
    list = JSON.parse(new URLSearchParams(await readBody(req)).get('paths') || '[]');
  }
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Nothing selected');
  const paths = list.map(resolvePath);
  const { items } = await collectZipItems(paths);
  await sendZip(res, { items, name: zipNameFor(paths) });
}

// ---------------------------------------------------------------------------
// API: chunked, resumable upload
//
// Each chunk is POSTed with ?path=<folder>&name=<relative file name>&id=<upload id>
// &offset=<bytes already sent>&total=<file size>. Data goes to "<name>.<id>.part"
// and is renamed to the real name (never overwriting) when the last byte arrives.
// ---------------------------------------------------------------------------

function uploadTarget(query) {
  const dir = resolvePath(query.path);
  const final = path.join(dir, ...cleanRelative(query.name));
  const id = String(query.id || '').replace(/[^\w-]/g, '').slice(0, 40);
  if (id.length < 6) throw new HttpError(400, 'Missing upload id');
  // the partial file's name does not depend on the real name, so very long names still work
  return { dir, final, id, part: path.join(path.dirname(final), `.${id}.part`) };
}

// Uploads that were cancelled (so a late chunk cannot bring the file back) and
// unfinished uploads (so abandoned partial files are removed after a while).
const cancelledUploads = new Map(); // id -> time
const openParts = new Map(); // part path -> last activity
const PART_MAX_IDLE = 6 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, t] of cancelledUploads) if (now - t > 60 * 60 * 1000) cancelledUploads.delete(id);
  for (const [token, expires] of sessions) if (expires < now) sessions.delete(token);
  for (const [token, plan] of zipPlans) if (plan.expires < now) zipPlans.delete(token);
  for (const [part, t] of openParts) {
    if (now - t > PART_MAX_IDLE) {
      openParts.delete(part);
      fsp.rm(part, { force: true }).catch(() => {});
    }
  }
}, 10 * 60 * 1000).unref();

async function apiUpload(req, res, query) {
  const { final, part, id } = uploadTarget(query);
  if (cancelledUploads.has(id)) throw new HttpError(410, 'Upload was cancelled');
  const offset = Number(query.offset || 0);
  const total = Number(query.total || 0);
  if (!Number.isInteger(offset) || !Number.isInteger(total) || offset < 0 || total < 0) {
    throw new HttpError(400, 'Invalid offset or total');
  }
  await fsp.mkdir(path.dirname(final), { recursive: true });
  if (offset > 0) {
    const st = await fsp.stat(part).catch(() => null);
    if (!st || st.size !== offset) throw new HttpError(409, 'Upload out of sync', { size: st ? st.size : 0 });
  }
  const out = fs.createWriteStream(part, { flags: offset === 0 ? 'w' : 'r+', start: offset });
  let received = 0;
  req.on('data', (c) => (received += c.length));
  openParts.set(part, Date.now());
  await pipeline(req, out);
  if (cancelledUploads.has(id)) {
    await fsp.rm(part, { force: true });
    throw new HttpError(410, 'Upload was cancelled');
  }
  if (offset + received >= total) {
    openParts.delete(part);
    const target = await uniquePath(final);
    await fsp.rename(part, target);
    return { done: true, name: path.basename(target), size: offset + received };
  }
  return { done: false, received: offset + received };
}

async function apiUploadStatus(query) {
  const { part } = uploadTarget(query);
  const st = await fsp.stat(part).catch(() => null);
  return { size: st ? st.size : 0 };
}

async function apiUploadCancel(query) {
  const { part, id } = uploadTarget(query);
  cancelledUploads.set(id, Date.now());
  openParts.delete(part);
  await fsp.rm(part, { force: true });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const abs = path.join(PUBLIC_DIR, rel);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');
  let data;
  try {
    data = await fsp.readFile(abs);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, {
    'Content-Type': STATIC_MIME[path.extname(abs)] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; frame-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'self'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}


// ---------------------------------------------------------------------------
// Password, sessions and blocking
//
// A visitor is recognised by TWO things: their network address (IP) and a
// random "device" cookie. Wrong passwords are counted for both. After
// MAX_WRONG mistakes, BOTH are blocked for 7 days (until the server restarts,
// because the block list lives only in memory). A blocked visitor gets nothing,
// not even with the right password.
// ---------------------------------------------------------------------------

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const PASSWORD_HASH = PASSWORD ? sha(PASSWORD) : null;
const sessions = new Map(); // token -> expires
const wrongCount = new Map(); // "ip:1.2.3.4" or "dev:abc" -> wrong passwords so far
const blockedUntil = new Map(); // same keys -> time the block ends

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function clientIp(req) {
  let ip = req.socket.remoteAddress || 'unknown';
  if (TRUST_PROXY && req.headers['x-forwarded-for']) ip = String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return ip.replace(/^::ffff:/, '');
}

const deviceKey = (id) => (id && /^[a-f0-9]{32}$/.test(id) ? `dev:${id}` : null);

function isBlocked(ip, deviceId) {
  const now = Date.now();
  for (const key of [`ip:${ip}`, deviceKey(deviceId)]) {
    if (!key) continue;
    const until = blockedUntil.get(key);
    if (until && until > now) return true;
    if (until) blockedUntil.delete(key);
  }
  return false;
}

function cookieHeader(req, name, value, maxAgeSec) {
  const secure = req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

function isLoggedIn(req) {
  if (!PASSWORD) return true;
  const token = parseCookies(req).fm_session;
  const expires = token && sessions.get(token);
  if (expires && expires > Date.now()) return true;
  if (expires) sessions.delete(token);
  return false;
}

const BLOCKED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blocked</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f6f8;color:#1a1f29}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#667085;margin:0}</style>
<main><h1>Access blocked</h1><p>Too many wrong passwords were entered from this device or network. It stays blocked until the server owner restarts the server.</p></main>`;

function sendBlocked(req, res, pathname) {
  if (pathname.startsWith('/api/')) return sendJson(res, 403, { error: 'Blocked after too many wrong passwords', blocked: true });
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(BLOCKED_PAGE);
}

async function apiLogin(req, res, ip, deviceId) {
  const body = await readJson(req);
  const supplied = sha(typeof body.password === 'string' ? body.password : '');
  const ok = PASSWORD_HASH && crypto.timingSafeEqual(supplied, PASSWORD_HASH);
  const keys = [`ip:${ip}`];
  let newDevice = null;
  if (!deviceKey(deviceId)) newDevice = crypto.randomBytes(16).toString('hex');
  const devKey = deviceKey(deviceId) || `dev:${newDevice}`;
  keys.push(devKey);
  const cookies = [];
  if (newDevice) cookies.push(cookieHeader(req, 'fm_dev', newDevice, 10 * 365 * 24 * 3600));

  if (ok) {
    for (const k of keys) wrongCount.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    cookies.push(cookieHeader(req, 'fm_session', token, SESSION_MS / 1000));
    res.setHeader('Set-Cookie', cookies);
    return sendJson(res, 200, { ok: true });
  }

  await new Promise((r) => setTimeout(r, 400)); // slows guessing down
  let worst = 0;
  for (const k of keys) {
    const n = (wrongCount.get(k) || 0) + 1;
    wrongCount.set(k, n);
    worst = Math.max(worst, n);
  }
  res.setHeader('Set-Cookie', cookies);
  if (worst >= MAX_WRONG) {
    const until = Date.now() + BLOCK_MS;
    for (const k of keys) blockedUntil.set(k, until);
    console.log(`Blocked ${ip} after ${MAX_WRONG} wrong passwords (until the server restarts, or 7 days)`);
    return sendJson(res, 403, { error: 'Too many wrong passwords. This device is now blocked.', blocked: true });
  }
  return sendJson(res, 401, { error: `Wrong password. ${MAX_WRONG - worst} ${MAX_WRONG - worst === 1 ? 'try' : 'tries'} left.`, left: MAX_WRONG - worst });
}

const PUBLIC_ASSETS = new Set(['/login.js', '/style.css', '/theme.js', '/favicon.svg']);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    const route = `${req.method} ${url.pathname}`;

    if (PASSWORD) {
      const ip = clientIp(req);
      const deviceId = parseCookies(req).fm_dev;
      if (isBlocked(ip, deviceId)) return sendBlocked(req, res, url.pathname);
      if (route === 'POST /api/login') return await apiLogin(req, res, ip, deviceId);
      if (route === 'POST /api/logout') {
        sessions.delete(parseCookies(req).fm_session);
        res.setHeader('Set-Cookie', cookieHeader(req, 'fm_session', '', 0));
        return sendJson(res, 200, { ok: true });
      }
      if (!isLoggedIn(req)) {
        if (req.method === 'GET' && url.pathname === '/') return await serveStatic(res, '/login.html');
        if (req.method === 'GET' && PUBLIC_ASSETS.has(url.pathname)) return await serveStatic(res, url.pathname);
        throw new HttpError(401, 'Password required');
      }
    }

    switch (route) {
      case 'GET /api/info': return sendJson(res, 200, await apiInfo());
      case 'GET /api/list': return sendJson(res, 200, await apiList(query));
      case 'POST /api/mkdir': return sendJson(res, 200, await apiMkdir(req));
      case 'POST /api/rename': return sendJson(res, 200, await apiRename(req));
      case 'POST /api/delete': return sendJson(res, 200, await apiDelete(req));
      case 'GET /api/download': return await apiDownload(req, res, query);
      case 'POST /api/zip': return await apiZip(req, res);
      case 'POST /api/zip-plan': return sendJson(res, 200, await apiZipPlan(req));
      case 'GET /api/zip': return await apiZipGet(res, query);
      case 'POST /api/upload': return sendJson(res, 200, await apiUpload(req, res, query));
      case 'GET /api/upload-status': return sendJson(res, 200, await apiUploadStatus(query));
      case 'POST /api/upload-cancel': return sendJson(res, 200, await apiUploadCancel(query));
      default:
    }
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Unknown API');
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    await serveStatic(res, url.pathname);
  } catch (raw) {
    const err = fsError(raw);
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) return res.destroy();
    const status = err instanceof HttpError ? err.status : 500;
    sendJson(res, status, { error: err instanceof HttpError ? err.message : 'Server error', ...(err.extra || {}) });
  }
});

server.requestTimeout = 0; // a big upload chunk on a slow link may take longer than the 5 min default
server.headersTimeout = 60_000;

function start(port = process.env.PORT === undefined ? 3999 : Number(process.env.PORT), host = process.env.HOST || '0.0.0.0') {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`Server running at http://localhost:${server.address().port}/`);
      console.log(PASSWORD
        ? `Password protection is ON (${MAX_WRONG} wrong tries blocks a visitor for 7 days, or until you restart).`
        : 'WARNING: no password set. Anyone who can reach this port can read, change and delete files. Set one with FM_PASSWORD=... or --password=...');
      resolve(server);
    });
  });
}

if (require.main === module) {
  start();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}

module.exports = { server, start };
