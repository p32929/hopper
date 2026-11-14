'use strict';
// API tests. Run against a fresh local server, or against a running one:
//   BASE_URL=http://192.168.1.108:3999 node --test tests/api.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readZip } = require('./zip');
const crypto = require('node:crypto');

let base = process.env.BASE_URL;
let child;
let root; // folder the local server is locked to (local mode only)
let sandbox; // folder all tests work in
const remote = Boolean(process.env.BASE_URL);

const json = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const list = async (p) => (await fetch(`${base}/api/list?path=${encodeURIComponent(p)}`)).json();
const names = async (p) => (await list(p)).entries.map((e) => e.name).sort();
const upload = (p, name, id, offset, total, body) =>
  fetch(`${base}/api/upload?${new URLSearchParams({ path: p, name, id, offset, total })}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });

before(async () => {
  if (!remote) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-api-'));
    child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', FM_ROOT: root } });
    base = await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { const m = /(http:\/\/localhost:\d+)/.exec(String(d)); if (m) resolve(m[1]); });
      child.on('exit', (c) => reject(new Error(`server exited ${c}`)));
      setTimeout(() => reject(new Error('server did not start')), 5000);
    });
  }
  const info = await (await fetch(`${base}/api/info`)).json();
  const res = await json('/api/mkdir', { path: info.home, name: `fm-api-${Date.now()}` });
  assert.equal(res.status, 200);
  sandbox = (await res.json()).path;
});

after(async () => {
  if (sandbox) await json('/api/delete', { paths: [sandbox] });
  if (child) child.kill();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('serves the page and its assets', async () => {
  for (const [url, type] of [['/', 'text/html'], ['/style.css', 'text/css'], ['/app.js', 'text/javascript']]) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type'), new RegExp(type));
  }
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2f..%2fserver.js`)).status, 404);
});

test('info describes the machine', async () => {
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.ok(info.hostname && info.home && info.sep && info.places.length);
});

test('mkdir, list, rename, delete', async () => {
  assert.equal((await json('/api/mkdir', { path: sandbox, name: 'alpha' })).status, 200);
  assert.equal((await json('/api/mkdir', { path: sandbox, name: 'alpha' })).status, 409, 'duplicate folder');
  assert.equal((await json('/api/mkdir', { path: sandbox, name: '../evil' })).status, 400, 'bad name');
  assert.deepEqual(await names(sandbox), ['alpha']);

  const alpha = path.join(sandbox, 'alpha');
  assert.equal((await json('/api/rename', { path: alpha, newName: 'beta' })).status, 200);
  assert.deepEqual(await names(sandbox), ['beta']);
  await json('/api/mkdir', { path: sandbox, name: 'gamma' });
  assert.equal((await json('/api/rename', { path: path.join(sandbox, 'beta'), newName: 'gamma' })).status, 409, 'rename onto existing');

  const del = await json('/api/delete', { paths: [path.join(sandbox, 'beta'), path.join(sandbox, 'gamma')] });
  assert.equal((await del.json()).deleted, 2);
  assert.deepEqual(await names(sandbox), []);
  assert.equal((await list(path.join(sandbox, 'missing'))).error, 'Not found');
});

test('relative or odd paths are refused instead of guessed', async () => {
  assert.equal((await fetch(`${base}/api/list?path=null`)).status, 400);
  assert.equal((await fetch(`${base}/api/list?path=${encodeURIComponent('/bad\0path')}`)).status, 400);
});

test('JSON endpoints refuse other content types', async () => {
  const res = await fetch(`${base}/api/mkdir`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
});

test('single-request upload, then a clash is renamed, never overwritten', async () => {
  const dir = path.join(sandbox, 'up1');
  await json('/api/mkdir', { path: sandbox, name: 'up1' });
  const a = await (await upload(dir, 'hello.txt', 'idsingle1', 0, 5, 'hello')).json();
  assert.deepEqual([a.done, a.name], [true, 'hello.txt']);
  const b = await (await upload(dir, 'hello.txt', 'idsingle2', 0, 5, 'world')).json();
  assert.equal(b.name, 'hello (1).txt');
  const dl = await fetch(`${base}/api/download?path=${encodeURIComponent(path.join(dir, 'hello.txt'))}`);
  assert.equal(await dl.text(), 'hello');
  assert.deepEqual(await names(dir), ['hello (1).txt', 'hello.txt']);
});

test('chunked upload keeps every byte, even for an empty file', async () => {
  const dir = path.join(sandbox, 'up2');
  await json('/api/mkdir', { path: sandbox, name: 'up2' });
  const data = Buffer.alloc(250_000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 251;
  let offset = 0;
  let last;
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + 64_000);
    last = await (await upload(dir, 'big.bin', 'idchunk01', offset, data.length, chunk)).json();
    offset += chunk.length;
  }
  assert.equal(last.done, true);
  const dl = Buffer.from(await (await fetch(`${base}/api/download?path=${encodeURIComponent(path.join(dir, 'big.bin'))}`)).arrayBuffer());
  assert.ok(dl.equals(data), 'downloaded bytes equal uploaded bytes');

  const empty = await (await upload(dir, 'empty.txt', 'idempty01', 0, 0, '')).json();
  assert.equal(empty.done, true);
  assert.equal((await list(dir)).entries.find((e) => e.name === 'empty.txt').size, 0);
});

test('upload resumes after a break and refuses out-of-order chunks', async () => {
  const dir = path.join(sandbox, 'up3');
  await json('/api/mkdir', { path: sandbox, name: 'up3' });
  const data = Buffer.from('0123456789'.repeat(100));
  await upload(dir, 'r.txt', 'idresume1', 0, data.length, data.subarray(0, 400));
  const status = await (await fetch(`${base}/api/upload-status?${new URLSearchParams({ path: dir, name: 'r.txt', id: 'idresume1' })}`)).json();
  assert.equal(status.size, 400);
  const wrong = await upload(dir, 'r.txt', 'idresume1', 100, data.length, data.subarray(100, 200));
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).size, 400, 'tells the client where to continue');
  const fin = await (await upload(dir, 'r.txt', 'idresume1', 400, data.length, data.subarray(400))).json();
  assert.equal(fin.done, true);
  assert.equal(await (await fetch(`${base}/api/download?path=${encodeURIComponent(path.join(dir, 'r.txt'))}`)).text(), data.toString());
  assert.deepEqual(await names(dir), ['r.txt'], 'no .part left behind');
});

test('cancel removes the partial file; unfinished parts stay hidden', async () => {
  const dir = path.join(sandbox, 'up4');
  await json('/api/mkdir', { path: sandbox, name: 'up4' });
  await upload(dir, 'c.bin', 'idcancel1', 0, 1000, Buffer.alloc(100));
  assert.deepEqual(await names(dir), [], 'part file is hidden from listings');
  const res = await fetch(`${base}/api/upload-cancel?${new URLSearchParams({ path: dir, name: 'c.bin', id: 'idcancel1' })}`, { method: 'POST' });
  assert.equal(res.status, 200);
  if (!remote) assert.deepEqual(fs.readdirSync(dir), []); // (files are only visible from here when the server is local)
});

test('a chunk that arrives after cancel is refused and leaves no file', async () => {
  const dir = path.join(sandbox, 'up4b');
  await json('/api/mkdir', { path: sandbox, name: 'up4b' });
  await fetch(`${base}/api/upload-cancel?${new URLSearchParams({ path: dir, name: 'late.bin', id: 'idlate001' })}`, { method: 'POST' });
  const late = await upload(dir, 'late.bin', 'idlate001', 0, 1000, Buffer.alloc(100));
  assert.equal(late.status, 410);
  if (!remote) assert.deepEqual(fs.readdirSync(dir), []);
});

test('folder uploads keep their structure; ".." cannot escape', async () => {
  const dir = path.join(sandbox, 'up5');
  await json('/api/mkdir', { path: sandbox, name: 'up5' });
  const ok = await upload(dir, 'photos/2024/a.txt', 'idnested1', 0, 1, 'a');
  assert.equal(ok.status, 200);
  assert.deepEqual(await names(path.join(dir, 'photos', '2024')), ['a.txt']);
  const bad = await upload(dir, '../escape.txt', 'idnested2', 0, 1, 'x');
  assert.equal(bad.status, 400);
  assert.ok(!fs.existsSync(path.join(sandbox, 'escape.txt')));
});

test('download supports ranges, inline previews and unicode names', async () => {
  const dir = path.join(sandbox, 'dl');
  await json('/api/mkdir', { path: sandbox, name: 'dl' });
  await upload(dir, 'ünï cödé.png', 'iddl00001', 0, 10, '0123456789');
  const file = path.join(dir, 'ünï cödé.png');
  const url = `${base}/api/download?path=${encodeURIComponent(file)}`;

  const part = await fetch(url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), '2345');
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal((await fetch(url, { headers: { Range: 'bytes=99-' } })).status, 416);

  const whole = await fetch(url);
  assert.match(whole.headers.get('content-disposition'), /^attachment; filename="[^"]*"; filename\*=UTF-8''%C3%BC/);
  const inline = await fetch(`${url}&inline=1`);
  assert.equal(inline.headers.get('content-type'), 'image/png');
  assert.match(inline.headers.get('content-disposition'), /^inline/);
  assert.equal((await fetch(`${base}/api/download?path=${encodeURIComponent(dir)}`)).status, 400, 'folder is not a file');
});

test('very long file names upload fine', async () => {
  const dir = path.join(sandbox, 'long');
  await json('/api/mkdir', { path: sandbox, name: 'long' });
  const name = 'x'.repeat(250) + '.txt';
  const res = await upload(dir, name, 'idlong001', 0, 3, 'abc');
  assert.equal(res.status, 200);
  assert.deepEqual(await names(dir), [name]);
});

test('code and text files open inline; unknown files are checked by content', async () => {
  const dir = path.join(sandbox, 'inl');
  await json('/api/mkdir', { path: sandbox, name: 'inl' });
  const files = { 'app.js': 'const a = 1;\n', 'Dockerfile': 'FROM node\n', 'notes.xyz': 'plain words', 'page.html': '<script>alert(1)</script>' };
  let n = 0;
  for (const [name, body] of Object.entries(files)) await upload(dir, name, `idinl000${n++}`, 0, body.length, body);
  await upload(dir, 'blob.xyz', 'idinl0009', 0, 4, Buffer.from([1, 0, 2, 255]));
  const entries = Object.fromEntries((await list(dir)).entries.map((e) => [e.name, e.preview]));
  assert.deepEqual(entries, { 'app.js': 'text', Dockerfile: 'text', 'notes.xyz': 'maybe', 'page.html': 'text', 'blob.xyz': 'maybe' });
  for (const name of ['app.js', 'Dockerfile', 'notes.xyz', 'page.html']) {
    const res = await fetch(`${base}/api/download?${new URLSearchParams({ path: path.join(dir, name), inline: 1 })}`);
    assert.match(res.headers.get('content-type'), /^text\/plain/, name);
    assert.match(res.headers.get('content-disposition'), /^inline/, name);
  }
  const bin = await fetch(`${base}/api/download?${new URLSearchParams({ path: path.join(dir, 'blob.xyz'), inline: 1 })}`);
  assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
  assert.match(bin.headers.get('content-disposition'), /^attachment/);
  const plain = await fetch(`${base}/api/download?path=${encodeURIComponent(path.join(dir, 'app.js'))}`);
  assert.match(plain.headers.get('content-disposition'), /^attachment/, 'without inline it still downloads');
});

test('ZIP contains files and folders, with correct bytes', async () => {
  const dir = path.join(sandbox, 'zip');
  await json('/api/mkdir', { path: sandbox, name: 'zip' });
  const big = Buffer.from('compress me please. '.repeat(20_000));
  await upload(dir, 'one.txt', 'idzip0001', 0, 3, 'one');
  await upload(dir, 'big.txt', 'idzip0002', 0, big.length, big);
  await upload(dir, 'sub/deep/two.txt', 'idzip0003', 0, 3, 'two');
  await json('/api/mkdir', { path: dir, name: 'empty-folder' });

  const res = await fetch(`${base}/api/zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ paths: JSON.stringify([path.join(dir, 'one.txt'), path.join(dir, 'big.txt'), path.join(dir, 'sub'), path.join(dir, 'empty-folder')]) }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const zip = readZip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(Object.keys(zip).sort(), ['big.txt', 'empty-folder/', 'one.txt', 'sub/', 'sub/deep/', 'sub/deep/two.txt']);
  assert.equal(zip['one.txt'].toString(), 'one');
  assert.ok(zip['big.txt'].equals(big));
  assert.equal(zip['sub/deep/two.txt'].toString(), 'two');
  assert.equal((await fetch(`${base}/api/zip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"paths":[]}' })).status, 400);
});

test('ZIP64: big files, big offsets and many entries use the right headers', { skip: remote && 'needs a local server with FM_TEST_ZIP64' }, async () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-z64-'));
  const proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', FM_ROOT: r2, FM_TEST_ZIP64: '1' } });
  try {
    const url = await new Promise((resolve, reject) => {
      proc.stdout.on('data', (d) => { const m = /(http:\/\/localhost:\d+)/.exec(String(d)); if (m) resolve(m[1]); });
      proc.on('exit', (c) => reject(new Error(`server exited ${c}`)));
    });
    // test limits: a file >= 1000 bytes is "big", offsets >= 3000 are "big", 5 entries are "many"
    const big = Buffer.alloc(2500);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13) % 251;
    fs.mkdirSync(path.join(r2, 'z'));
    fs.writeFileSync(path.join(r2, 'z', 'big.bin'), big);
    fs.writeFileSync(path.join(r2, 'z', 'ünï.txt'), 'unicode name');
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(r2, 'z', `small${i}.txt`), `small ${i}`);
    fs.writeFileSync(path.join(r2, 'z', 'later.bin'), crypto.randomBytes(2000)); // starts after offset 3000? stored below
    const res = await fetch(`${url}/api/zip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [path.join(r2, 'z')] }) });
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = readZip(buf);
    assert.equal(zip.__info.zip64, true, 'ZIP64 records are present');
    assert.ok(zip.__info.unicodeExtra >= 1, 'the non-ASCII name carries the Unicode path field');
    assert.ok(zip['z/big.bin'].equals(big));
    assert.equal(zip['z/ünï.txt'].toString(), 'unicode name');
    for (let i = 0; i < 6; i++) assert.equal(zip[`z/small${i}.txt`].toString(), `small ${i}`);
    assert.equal(Object.keys(zip).length, 10);
    // an independent reader must agree
    const tmp = path.join(r2, 'out.zip');
    fs.writeFileSync(tmp, buf);
    const py = require('node:child_process').spawnSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip() or "ok", len(z.namelist()))', tmp]);
    assert.match(String(py.stdout), /^ok 10/, String(py.stderr));
  } finally {
    proc.kill();
    fs.rmSync(r2, { recursive: true, force: true });
  }
});

test('two-step ZIP download: errors come back as messages, the link works once', async () => {
  const dir = path.join(sandbox, 'plan');
  await json('/api/mkdir', { path: sandbox, name: 'plan' });
  await upload(dir, 'a.txt', 'idplan001', 0, 1, 'a');
  await json('/api/mkdir', { path: dir, name: 'sub' });
  await upload(path.join(dir, 'sub'), 'b.txt', 'idplan002', 0, 1, 'b');
  const plan = await (await json('/api/zip-plan', { paths: [dir] })).json();
  assert.deepEqual([plan.files, plan.folders, plan.bytes], [2, 2, 2]);
  const got = await fetch(`${base}/api/zip?token=${plan.token}`);
  assert.equal(got.status, 200);
  assert.match(got.headers.get('content-disposition'), /plan\.zip/);
  assert.deepEqual(Object.keys(readZip(Buffer.from(await got.arrayBuffer()))).sort(), ['plan/', 'plan/a.txt', 'plan/sub/', 'plan/sub/b.txt']);
  assert.equal((await fetch(`${base}/api/zip?token=${plan.token}`)).status, 410, 'one use only');
  assert.equal((await json('/api/zip-plan', { paths: [path.join(sandbox, 'nope')] })).status, 404);
  assert.equal((await json('/api/zip-plan', { paths: [] })).status, 400);
});

test('creating nested folders in one go (empty folders in a folder upload)', async () => {
  const res = await json('/api/mkdir', { path: sandbox, name: 'x/y/z', parents: true });
  assert.equal(res.status, 200);
  assert.equal((await json('/api/mkdir', { path: sandbox, name: 'x/y/z', parents: true })).status, 200, 'already there is fine');
  assert.equal((await json('/api/mkdir', { path: sandbox, name: '../escape', parents: true })).status, 400);
  assert.deepEqual(await names(path.join(sandbox, 'x', 'y')), ['z']);
});

test('refuses to delete the root or home folder', async () => {
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.equal((await json('/api/delete', { paths: [info.home] })).status, 403);
  assert.equal((await json('/api/delete', { paths: [info.sep] })).status, 403);
});

test('FM_ROOT keeps everything inside the chosen folder', { skip: remote && 'needs a local server' }, async () => {
  assert.equal((await fetch(`${base}/api/list?path=${encodeURIComponent(os.tmpdir())}`)).status, 403);
  assert.equal((await fetch(`${base}/api/list?path=${encodeURIComponent(root + '/../')}`)).status, 403);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'link-out'));
  assert.equal((await fetch(`${base}/api/list?path=${encodeURIComponent(path.join(root, 'link-out'))}`)).status, 403, 'symlink out of the root');
  assert.equal((await fetch(`${base}/api/list?path=${encodeURIComponent(root)}`)).status, 200);
});
