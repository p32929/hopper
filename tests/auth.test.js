'use strict';
// Password and blocking tests. Starts its own password-protected server.
//   AUTH_URL=http://host:3998 AUTH_PASSWORD=... node --test tests/auth.test.js   (a server started with FM_TRUST_PROXY=1)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PASSWORD = process.env.AUTH_PASSWORD || 'correct horse battery';
let base = process.env.AUTH_URL;
let child;
let root;
let counter = 0;

async function startServer() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', FM_ROOT: root, FM_PASSWORD: PASSWORD, FM_TRUST_PROXY: '1' },
  });
  const url = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { const m = /(http:\/\/localhost:\d+)/.exec(String(d)); if (m) resolve(m[1]); });
    proc.on('exit', (c) => reject(new Error(`server exited ${c}`)));
    setTimeout(() => reject(new Error('server did not start')), 5000);
  });
  return { proc, url };
}

before(async () => {
  if (!base) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-auth-'));
    ({ proc: child, url: base } = await startServer());
  }
});
after(() => {
  child?.kill();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** A visitor with their own address and (once the server gives one) their own cookies. */
function visitor() {
  const ip = `10.7.${Math.floor(++counter / 250)}.${(counter % 250) + 1}`;
  const jar = {};
  const v = {
    ip, jar,
    async fetch(url, init = {}) {
      const res = await fetch(base + url, {
        redirect: 'manual',
        ...init,
        headers: { 'X-Forwarded-For': v.ip, Cookie: Object.entries(jar).map(([k, x]) => `${k}=${x}`).join('; '), ...init.headers },
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        const val = pair.slice(i + 1);
        if (val) jar[pair.slice(0, i)] = val; else delete jar[pair.slice(0, i)];
      }
      return res;
    },
    login: (password) => v.fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }),
  };
  return v;
}

test('nothing is shown before signing in', async () => {
  const v = visitor();
  const page = await v.fetch('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign in/);
  assert.equal((await v.fetch('/api/info')).status, 401);
  assert.equal((await v.fetch('/api/list?path=/')).status, 401);
  assert.equal((await v.fetch('/app.js')).status, 401, 'the app itself needs a login too');
  assert.equal((await v.fetch('/style.css')).status, 200, 'the login page needs its styles');
  const forged = await v.fetch('/api/info', { headers: { Cookie: 'fm_session=' + 'a'.repeat(64) } });
  assert.equal(forged.status, 401);
});

test('the right password unlocks; sign out locks again', async () => {
  const v = visitor();
  const res = await v.login(PASSWORD);
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('fm_session='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const info = await (await v.fetch('/api/info')).json();
  assert.equal(info.auth, true);
  assert.match(await (await v.fetch('/')).text(), /Hopper/);
  assert.doesNotMatch(await (await v.fetch('/')).text(), /Sign in/);
  assert.equal((await v.fetch('/api/logout', { method: 'POST' })).status, 200);
  assert.equal((await v.fetch('/api/info')).status, 401);
});

test('wrong passwords count down: 4 tries left, 3, 2, 1', async () => {
  const v = visitor();
  const left = [];
  for (let i = 0; i < 4; i++) {
    const res = await v.login('nope');
    assert.equal(res.status, 401);
    left.push((await res.json()).left);
  }
  assert.deepEqual(left, [4, 3, 2, 1]);
  assert.equal((await v.login(PASSWORD)).status, 200, 'still allowed after 4 mistakes');
});

test('a correct password resets the count', async () => {
  const v = visitor();
  for (let i = 0; i < 4; i++) await v.login('nope');
  assert.equal((await v.login(PASSWORD)).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await v.login('nope')).status, 401);
  assert.equal((await v.login(PASSWORD)).status, 200);
});

test('the 5th wrong password blocks everything, even the right password', async () => {
  const v = visitor();
  for (let i = 0; i < 4; i++) assert.equal((await v.login('nope')).status, 401);
  const fifth = await v.login('nope');
  assert.equal(fifth.status, 403);
  assert.equal((await fifth.json()).blocked, true);

  assert.equal((await v.login(PASSWORD)).status, 403, 'right password no longer works');
  const page = await v.fetch('/');
  assert.equal(page.status, 403);
  assert.match(await page.text(), /Access blocked/);
  assert.equal((await v.fetch('/api/info')).status, 403);
  assert.equal((await v.fetch('/style.css')).status, 403, 'not even the login page assets');

  // same address, brand new browser (no cookies)
  const sameIp = visitor();
  sameIp.ip = v.ip;
  assert.equal((await sameIp.fetch('/')).status, 403, 'blocked by address');

  // same browser (cookie), new address
  const sameBrowser = visitor();
  sameBrowser.jar.fm_dev = v.jar.fm_dev;
  assert.ok(v.jar.fm_dev, 'the browser got a device cookie');
  assert.equal((await sameBrowser.fetch('/')).status, 403, 'blocked by browser');
  assert.equal((await sameBrowser.login(PASSWORD)).status, 403);

  // a different person is unaffected
  const other = visitor();
  assert.equal((await other.login(PASSWORD)).status, 200);
});

test('a signed-in session cannot be used by a blocked browser', async () => {
  const v = visitor();
  assert.equal((await v.login(PASSWORD)).status, 200);
  const attacker = visitor();
  attacker.jar.fm_dev = v.jar.fm_dev;
  for (let i = 0; i < 5; i++) await attacker.login('nope');
  assert.equal((await v.fetch('/api/info')).status, 403, 'the shared browser id is blocked, so everything is');
});

test('mistakes are counted per visitor, not for everyone together', async () => {
  const a = visitor();
  const b = visitor();
  for (let i = 0; i < 3; i++) { await a.login('nope'); await b.login('nope'); }
  assert.equal((await a.login(PASSWORD)).status, 200);
  assert.equal((await b.login(PASSWORD)).status, 200);
});

test('restarting the server lifts every block', { skip: process.env.AUTH_URL && 'needs a local server' }, async () => {
  const v = visitor();
  for (let i = 0; i < 5; i++) await v.login('nope');
  assert.equal((await v.fetch('/')).status, 403);
  child.kill();
  await new Promise((r) => child.on('exit', r));
  ({ proc: child, url: base } = await startServer());
  assert.equal((await v.login(PASSWORD)).status, 200, 'unblocked after the restart');
});
