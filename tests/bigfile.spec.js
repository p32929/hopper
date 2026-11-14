// Big-file check in a real browser: upload a big file, download it back, compare checksums.
//   BIG_FILE=/path/to/big.bin npx playwright test tests/bigfile.spec.js            (upload, then download it back)
//   BIG_FOLDER=/path/to/folder npx playwright test tests/bigfile.spec.js           (upload a whole folder, download it as a ZIP, compare every file)
//   BIG_DOWNLOAD=/path/on/server BIG_DOWNLOAD_SHA=<sha256> ...                      (download a file that already lives on the server)
//   BASE_URL=http://host:3999 BIG_PASSWORD=... to test a running server with a password.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BIG_FILE = process.env.BIG_FILE;
const BIG_DOWNLOAD = process.env.BIG_DOWNLOAD;

const sha256 = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
const mb = (n) => (n / 1048576).toFixed(0);

async function signIn(page) {
  await page.goto('/');
  if (await page.getByLabel('Password').isVisible().catch(() => false)) {
    await page.getByLabel('Password').fill(process.env.BIG_PASSWORD || '');
    await page.getByRole('button', { name: 'Unlock' }).click();
  }
  await expect(page.getByTestId('breadcrumb')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(30 * 60 * 1000);

test('uploads a big file, then downloads it back unchanged', async ({ page }) => {
  test.skip(!BIG_FILE, 'set BIG_FILE to a big file');
  const size = fs.statSync(BIG_FILE).size;
  const name = path.basename(BIG_FILE);
  const wanted = await sha256(BIG_FILE);

  await signIn(page);
  const info = await (await page.request.get('/api/info')).json();
  const dir = (await (await page.request.post('/api/mkdir', { data: { path: info.home, name: `big-test-${Date.now()}` } })).json()).path;
  try {
    await page.goto(`/#${encodeURI(dir)}`);
    await expect(page.getByTestId('breadcrumb')).toContainText(path.basename(dir));

    // ---- upload ----
    const t0 = Date.now();
    await page.locator('#file-input').setInputFiles(BIG_FILE);
    const item = page.locator('[data-testid=upload-item]');
    await expect(item).toHaveAttribute('data-state', 'uploading');
    await expect(page.locator('#uploads-sub')).toContainText('/s', { timeout: 60_000 }); // speed is shown while it runs
    await expect(item).toHaveAttribute('data-state', 'done', { timeout: 25 * 60 * 1000 });
    const upSec = (Date.now() - t0) / 1000;
    const row = page.locator(`[data-testid=row][data-name="${name}"]`);
    await expect(row).toBeVisible();
    const listed = (await (await page.request.get(`/api/list?path=${encodeURIComponent(dir)}`)).json()).entries.find((e) => e.name === name);
    expect(listed.size, 'size on the server equals the file').toBe(size);
    console.log(`UPLOAD   ${mb(size)} MB in ${upSec.toFixed(1)} s = ${(size / 1048576 / upSec).toFixed(1)} MB/s`);

    // ---- download ----
    await row.hover();
    const t1 = Date.now();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), row.getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toBe(name);
    const saved = await dl.path();
    expect(await dl.failure()).toBeNull();
    const downSec = (Date.now() - t1) / 1000;
    expect(fs.statSync(saved).size, 'downloaded size').toBe(size);
    expect(await sha256(saved), 'downloaded bytes are identical to the original').toBe(wanted);
    console.log(`DOWNLOAD ${mb(size)} MB in ${downSec.toFixed(1)} s = ${(size / 1048576 / downSec).toFixed(1)} MB/s, checksum matches`);

    // ---- partial (resume-style) download of the middle ----
    const mid = Math.floor(size / 2);
    const part = await page.request.get(`/api/download?path=${encodeURIComponent(dir + info.sep + name)}`, { headers: { Range: `bytes=${mid}-${mid + 99}` } });
    expect(part.status()).toBe(206);
    const fd = fs.openSync(BIG_FILE, 'r');
    const expected = Buffer.alloc(100);
    fs.readSync(fd, expected, 0, 100, mid);
    fs.closeSync(fd);
    expect(Buffer.from(await part.body()).equals(expected)).toBe(true);
  } finally {
    await page.request.post('/api/delete', { data: { paths: [dir] } });
  }
});

test('downloads a big file that already lives on the server', async ({ page }) => {
  test.skip(!BIG_DOWNLOAD, 'set BIG_DOWNLOAD and BIG_DOWNLOAD_SHA');
  await signIn(page);
  const dir = path.posix.dirname(BIG_DOWNLOAD);
  const name = path.posix.basename(BIG_DOWNLOAD);
  await page.goto(`/#${encodeURI(dir)}`);
  const row = page.locator(`[data-testid=row][data-name="${name}"]`);
  await expect(row).toBeVisible();
  const size = (await (await page.request.get(`/api/list?path=${encodeURIComponent(dir)}`)).json()).entries.find((e) => e.name === name).size;
  await row.hover();
  const t = Date.now();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), row.getByRole('button', { name: 'Download' }).click()]);
  const saved = await dl.path();
  expect(await dl.failure()).toBeNull();
  const sec = (Date.now() - t) / 1000;
  expect(fs.statSync(saved).size).toBe(size);
  expect(await sha256(saved)).toBe(process.env.BIG_DOWNLOAD_SHA);
  console.log(`DOWNLOAD ${mb(size)} MB in ${sec.toFixed(1)} s = ${(size / 1048576 / sec).toFixed(1)} MB/s, checksum matches the server's own sha256`);
});

// Every file under dir -> { "relative/path": sha256 } (folders count too, as "path/")
async function tree(dir, rel = '') {
  const out = {};
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { out[`${r}/`] = 'dir'; Object.assign(out, await tree(dir, r)); } else out[r] = await sha256(path.join(dir, r));
  }
  return out;
}

test('uploads a whole folder, then downloads it as a ZIP with every file intact', async ({ page }) => {
  const BIG_FOLDER = process.env.BIG_FOLDER;
  test.skip(!BIG_FOLDER, 'set BIG_FOLDER to a folder with many and large files');
  const top = path.basename(BIG_FOLDER);
  const wanted = await tree(BIG_FOLDER);
  const files = Object.keys(wanted).filter((k) => !k.endsWith('/')).length;
  const total = Object.keys(wanted).filter((k) => !k.endsWith('/')).reduce((n, k) => n + fs.statSync(path.join(BIG_FOLDER, k)).size, 0);

  await signIn(page);
  const info = await (await page.request.get('/api/info')).json();
  const dir = (await (await page.request.post('/api/mkdir', { data: { path: info.home, name: `folder-test-${Date.now()}` } })).json()).path;
  const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hopper-unzip-'));
  try {
    await page.goto(`/#${encodeURI(dir)}`);
    await expect(page.getByTestId('breadcrumb')).toContainText(path.basename(dir));

    const t0 = Date.now();
    await page.locator('#dir-input').setInputFiles(BIG_FOLDER);
    await expect(page.locator('#uploads-title')).toContainText(/Uploaded \d+ files?$/, { timeout: 25 * 60 * 1000 });
    expect(await page.locator('[data-testid=upload-item][data-state=error]').count(), 'no failed uploads').toBe(0);
    console.log(`UPLOAD   folder with ${files} files, ${mb(total)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const row = page.locator(`[data-testid=row][data-name="${top}"]`);
    await expect(row).toBeVisible();

    // the server must hold exactly the same files (checked through the API: sizes)
    const walk = async (p) => {
      const l = (await (await page.request.get(`/api/list?path=${encodeURIComponent(p)}`)).json()).entries;
      let n = 0;
      for (const e of l) n += e.type === 'dir' ? await walk(p + info.sep + e.name) : 1;
      return n;
    };
    expect(await walk(dir + info.sep + top), 'files on the server').toBe(files);

    const t1 = Date.now();
    await row.hover();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), row.getByRole('button', { name: 'Download as ZIP' }).click()]);
    const zipPath = await dl.path();
    expect(await dl.failure()).toBeNull();
    console.log(`DOWNLOAD zip ${mb(fs.statSync(zipPath).size)} MB in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    expect(dl.suggestedFilename()).toBe(`${top}.zip`);

    // unpack with Python's zipfile (it checks every CRC and reads ZIP64; macOS's own unzip cannot do non-ASCII names), then compare checksums
    require('node:child_process').execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);z.extractall(sys.argv[2])', zipPath, out], { maxBuffer: 1 << 28 });
    const got = await tree(path.join(out, top));
    expect(Object.keys(got).length, 'same number of entries').toBe(Object.keys(wanted).length);
    for (const [k, v] of Object.entries(wanted)) expect(got[k], k).toBe(v);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    await page.request.post('/api/delete', { data: { paths: [dir] } });
  }
});
