// End-to-end tests: a real browser drives the real server.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readZip } = require('./zip');

let sandbox; // a fresh folder on the server for every test
let sep = '/';

const post = (request, url, data) => request.post(url, { data });
const row = (page, name) => page.locator(`[data-testid=row][data-name="${name}"]`);
const rows = (page) => page.getByTestId('row');
const names = (page) => rows(page).evaluateAll((els) => els.map((e) => e.dataset.name));
const seed = (request, dir, name, body) =>
  request.post(`/api/upload?${new URLSearchParams({ path: dir, name, id: `seed${Math.random().toString(36).slice(2, 10)}`, offset: 0, total: Buffer.byteLength(body) })}`,
    { data: Buffer.from(body), headers: { 'Content-Type': 'application/octet-stream' } });
const readDir = async (request, dir) => (await (await request.get(`/api/list?path=${encodeURIComponent(dir)}`)).json()).entries;
const download = async (request, file) => Buffer.from(await (await request.get(`/api/download?path=${encodeURIComponent(file)}`)).body());
const open = async (page, dir = sandbox) => {
  await page.goto(`/#${encodeURI(dir)}`);
  await expect(page.getByTestId('breadcrumb')).toContainText(path.basename(dir)); // folder is loaded
};

test.beforeEach(async ({ request }) => {
  const info = await (await request.get('/api/info')).json();
  sep = info.sep;
  const res = await post(request, '/api/mkdir', { path: info.home, name: `fm-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  sandbox = (await res.json()).path;
});

test.afterEach(async ({ request }) => {
  await post(request, '/api/delete', { paths: [sandbox] });
});

test('loads and lists folders before files, with sizes', async ({ page, request }) => {
  await post(request, '/api/mkdir', { path: sandbox, name: 'Zebra' });
  await seed(request, sandbox, 'b.txt', 'bbbb');
  await seed(request, sandbox, 'a.png', 'aa');
  await open(page);
  await expect(page.getByTestId('breadcrumb')).toContainText(path.basename(sandbox));
  await expect.poll(() => names(page)).toEqual(['Zebra', 'a.png', 'b.txt']);
  await expect(row(page, 'b.txt')).toContainText('4 B');
  await expect(page.getByTestId('status')).toHaveText('1 folder · 2 files · 6 B');
  await expect(page).toHaveTitle(/Hopper/);
});

test('opens folders, goes up, uses breadcrumbs, back button and deep links', async ({ page, request }) => {
  await post(request, '/api/mkdir', { path: sandbox, name: 'inner' });
  await seed(request, sandbox + sep + 'inner', 'deep.txt', 'x');
  await open(page);
  await row(page, 'inner').click();
  await expect(row(page, 'deep.txt')).toBeVisible();
  await expect(page).toHaveURL(/inner$/);

  await page.getByRole('button', { name: 'Go to parent folder' }).click();
  await expect(row(page, 'inner')).toBeVisible();

  await page.goBack(); // browser history: back to "inner"
  await expect(row(page, 'deep.txt')).toBeVisible();

  await page.reload(); // the URL is a deep link
  await expect(row(page, 'deep.txt')).toBeVisible();

  await page.locator('.crumb').nth(-2).click();
  await expect(row(page, 'inner')).toBeVisible();
});

test('typing a path jumps to it; a bad path shows a friendly error', async ({ page }) => {
  await open(page);
  const box = await page.getByTestId('breadcrumb').boundingBox();
  await page.getByTestId('breadcrumb').click({ position: { x: box.width - 12, y: box.height / 2 } }); // empty space after the path
  const input = page.getByLabel('Folder path');
  await input.fill(sandbox + sep + 'does-not-exist');
  await input.press('Enter');
  await expect(page.getByTestId('empty-state')).toContainText("Can't open this folder");
  await page.getByRole('button', { name: 'Go to Home' }).click();
  await expect(row(page, path.basename(sandbox))).toBeVisible(); // Home holds this test's folder
});

test('filter, sort, hidden files, grid view and theme are remembered', async ({ page, request }) => {
  await seed(request, sandbox, 'apple.txt', 'a');
  await seed(request, sandbox, 'banana.txt', 'bbbbbbbbbb');
  await seed(request, sandbox, 'cherry.txt', 'cc');
  await seed(request, sandbox, '.secret', 's');
  await open(page);
  await expect.poll(() => names(page)).toEqual(['apple.txt', 'banana.txt', 'cherry.txt']);
  await expect(page.getByTestId('status')).toContainText('1 hidden');

  await page.getByRole('button', { name: 'Show hidden files' }).click();
  await expect(row(page, '.secret')).toBeVisible();
  await expect(row(page, '.secret')).toHaveClass(/is-hidden/);
  await expect(row(page, 'apple.txt')).not.toHaveClass(/is-hidden/);
  expect(await row(page, '.secret').locator('.cell-name').evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.7);
  await page.getByRole('button', { name: 'Show hidden files' }).click();

  await page.getByLabel('Filter this folder').fill('an');
  await expect.poll(() => names(page)).toEqual(['banana.txt']);
  await page.getByLabel('Filter this folder').fill('zzz');
  await expect(page.getByTestId('empty-state')).toContainText('No matches');
  await page.getByLabel('Filter this folder').fill('');

  await page.getByRole('button', { name: 'Sort by size' }).click();
  await expect.poll(() => names(page)).toEqual(['apple.txt', 'cherry.txt', 'banana.txt']);
  await page.getByRole('button', { name: 'Sort by size' }).click();
  await expect.poll(() => names(page)).toEqual(['banana.txt', 'cherry.txt', 'apple.txt']);

  await page.getByRole('button', { name: 'Switch view' }).click();
  await expect(page.getByTestId('listing')).toHaveClass(/grid/);
  await page.getByRole('button', { name: 'Switch theme' }).click();
  await page.reload();
  await expect(page.getByTestId('listing')).toHaveClass(/grid/);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.getByRole('button', { name: 'Switch theme' }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(theme);
});

test('creates a folder, and refuses a duplicate name', async ({ page, request }) => {
  await open(page);
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Holiday photos');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(row(page, 'Holiday photos')).toBeVisible();
  expect((await readDir(request, sandbox)).map((e) => e.name)).toEqual(['Holiday photos']);

  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Holiday photos');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'already exists' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('a/b');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'cannot contain' })).toBeVisible();
});

test('renames a file from the row button and with F2', async ({ page, request }) => {
  await seed(request, sandbox, 'draft.txt', 'text');
  await open(page);
  await row(page, 'draft.txt').hover();
  await row(page, 'draft.txt').getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('New name').fill('final.txt');
  await page.locator('#dlg-ok').click();
  await expect(row(page, 'final.txt')).toBeVisible();
  await expect(row(page, 'draft.txt')).toHaveCount(0);
  expect((await download(request, sandbox + sep + 'final.txt')).toString()).toBe('text');

  await row(page, 'final.txt').getByRole('checkbox').check();
  await page.keyboard.press('F2');
  await page.getByLabel('New name').fill('last.txt');
  await page.keyboard.press('Enter');
  await expect(row(page, 'last.txt')).toBeVisible();
});

test('uploads files with the file picker and shows progress and result', async ({ page, request }) => {
  await open(page);
  await page.locator('#file-input').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('my notes') },
    { name: 'data.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(200_000, 7) },
  ]);
  const panel = page.getByTestId('uploads');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Uploaded 2 files');
  await expect(page.locator('[data-testid=upload-item][data-state=done]')).toHaveCount(2);
  await expect(row(page, 'notes.txt')).toBeVisible();
  await expect(row(page, 'data.bin')).toContainText('195 KB');
  expect((await download(request, sandbox + sep + 'notes.txt')).toString()).toBe('my notes');
  expect((await download(request, sandbox + sep + 'data.bin')).equals(Buffer.alloc(200_000, 7))).toBe(true);
});

test('big files go up in several chunks and arrive intact', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('fm.chunk', '50000'));
  await open(page);
  const data = Buffer.alloc(260_000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 253;
  await page.locator('#file-input').setInputFiles({ name: 'chunky.dat', mimeType: 'application/octet-stream', buffer: data });
  await expect(page.locator('[data-testid=upload-item][data-state=done]')).toHaveCount(1);
  expect((await download(request, sandbox + sep + 'chunky.dat')).equals(data)).toBe(true);
});

test('uploading a name that already exists keeps both files', async ({ page, request }) => {
  await seed(request, sandbox, 'same.txt', 'old');
  await open(page);
  await page.locator('#file-input').setInputFiles({ name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('new') });
  await expect(row(page, 'same (1).txt')).toBeVisible();
  expect((await download(request, sandbox + sep + 'same.txt')).toString()).toBe('old');
  expect((await download(request, sandbox + sep + 'same (1).txt')).toString()).toBe('new');
});

test('uploads a whole folder and keeps its structure', async ({ page, request }) => {
  await open(page);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-up-'));
  fs.mkdirSync(path.join(dir, 'trip', 'day1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'trip', 'plan.txt'), 'plan');
  fs.writeFileSync(path.join(dir, 'trip', 'day1', 'map.txt'), 'map');
  await page.locator('#dir-input').setInputFiles(path.join(dir, 'trip'));
  await expect(row(page, 'trip')).toBeVisible();
  expect((await readDir(request, sandbox + sep + 'trip')).map((e) => e.name).sort()).toEqual(['day1', 'plan.txt']);
  expect((await download(request, [sandbox, 'trip', 'day1', 'map.txt'].join(sep))).toString()).toBe('map');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('drag and drop uploads and shows the drop overlay', async ({ page, request }) => {
  await open(page);
  await expect(rows(page)).toHaveCount(0);
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['dropped!'], 'dropped.txt', { type: 'text/plain' }));
    return d;
  });
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt });
  await expect(page.getByText('Drop to upload')).toBeVisible();
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await expect(page.getByText('Drop to upload')).toBeHidden();
  await expect(row(page, 'dropped.txt')).toBeVisible();
  expect((await download(request, sandbox + sep + 'dropped.txt')).toString()).toBe('dropped!');
});

test('an upload can be cancelled and leaves nothing behind', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('fm.chunk', '40000'));
  await page.route('**/api/upload?*', async (route) => { await new Promise((r) => setTimeout(r, 400)); await route.continue().catch(() => {}); });
  await open(page);
  await page.locator('#file-input').setInputFiles({ name: 'slow.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(400_000, 1) });
  const item = page.locator('[data-testid=upload-item]');
  await expect(item).toHaveAttribute('data-state', 'uploading');
  await item.getByRole('button', { name: 'Cancel slow.bin' }).click();
  await expect(item).toHaveAttribute('data-state', 'cancelled');
  await page.unroute('**/api/upload?*');
  await page.waitForTimeout(600);
  expect(await readDir(request, sandbox)).toEqual([]);
  expect(fs.existsSync(sandbox) ? fs.readdirSync(sandbox) : []).toEqual([]);
});

test('an upload recovers from a dropped connection', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('fm.chunk', '50000'));
  let failed = false;
  await page.route('**/api/upload?*', async (route) => {
    if (!failed && route.request().url().includes('offset=50000')) { failed = true; return route.abort('connectionreset'); }
    return route.continue();
  });
  await open(page);
  const data = Buffer.alloc(180_000, 9);
  await page.locator('#file-input').setInputFiles({ name: 'flaky.bin', mimeType: 'application/octet-stream', buffer: data });
  await expect(page.locator('[data-testid=upload-item]')).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
  expect(failed).toBe(true);
  expect((await download(request, sandbox + sep + 'flaky.bin')).equals(data)).toBe(true);
});

test('downloads a single file with the right name and content', async ({ page, request }) => {
  await seed(request, sandbox, 'report.csv', 'a,b\n1,2\n');
  await open(page);
  await row(page, 'report.csv').hover();
  const [dl] = await Promise.all([page.waitForEvent('download'), row(page, 'report.csv').getByRole('button', { name: 'Download' }).click()]);
  expect(dl.suggestedFilename()).toBe('report.csv');
  expect(fs.readFileSync(await dl.path(), 'utf8')).toBe('a,b\n1,2\n');
});

test('selects several items and downloads them as one valid ZIP', async ({ page, request }) => {
  await post(request, '/api/mkdir', { path: sandbox, name: 'docs' });
  await seed(request, sandbox + sep + 'docs', 'inside.txt', 'inside');
  await seed(request, sandbox, 'one.txt', 'first');
  await seed(request, sandbox, 'two.txt', 'second');
  await open(page);
  await row(page, 'docs').getByRole('checkbox').check();
  await row(page, 'one.txt').getByRole('checkbox').check();
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
  await page.locator('#check-all').check();
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected');
  await row(page, 'two.txt').getByRole('checkbox').uncheck();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-download').click()]);
  expect(dl.suggestedFilename()).toMatch(/^files-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = readZip(fs.readFileSync(await dl.path()));
  expect(Object.keys(zip).sort()).toEqual(['docs/', 'docs/inside.txt', 'one.txt']);
  expect(zip['docs/inside.txt'].toString()).toBe('inside');
  expect(zip['one.txt'].toString()).toBe('first');
});

test('shift-click selects a range; Escape clears', async ({ page, request }) => {
  for (const n of ['a', 'b', 'c', 'd']) await seed(request, sandbox, `${n}.txt`, n);
  await open(page);
  await row(page, 'a.txt').getByRole('checkbox').check();
  await row(page, 'd.txt').getByRole('checkbox').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('selection-count')).toHaveText('4 selected');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('selection-count')).toBeHidden();
});

test('deleting asks first; cancel keeps the file, confirm removes it', async ({ page, request }) => {
  await post(request, '/api/mkdir', { path: sandbox, name: 'old stuff' });
  await seed(request, sandbox + sep + 'old stuff', 'x.txt', 'x');
  await seed(request, sandbox, 'keep.txt', 'k');
  await open(page);

  await row(page, 'keep.txt').hover();
  await row(page, 'keep.txt').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { name: 'Delete “keep.txt”?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(row(page, 'keep.txt')).toBeVisible();

  await row(page, 'keep.txt').getByRole('checkbox').check();
  await row(page, 'old stuff').getByRole('checkbox').check();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('heading', { name: 'Delete 2 items?' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('empty-state')).toContainText('This folder is empty');
  expect(await readDir(request, sandbox)).toEqual([]);
});

test('previews images and text; other files download', async ({ page, request }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await request.post(`/api/upload?${new URLSearchParams({ path: sandbox, name: 'dot.png', id: 'pngseed01', offset: 0, total: png.length })}`, { data: png, headers: { 'Content-Type': 'application/octet-stream' } });
  await seed(request, sandbox, 'readme.txt', 'hello preview');
  await open(page);
  await row(page, 'dot.png').click();
  const preview = page.getByTestId('preview');
  await expect(preview.locator('img')).toBeVisible();
  await expect.poll(() => preview.locator('img').evaluate((i) => i.naturalWidth)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  await row(page, 'readme.txt').click();
  await expect(page.getByTestId('code')).toContainText('hello preview');
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
});

test('opens code and text files in a viewer with colours and line numbers', async ({ page, request }) => {
  await seed(request, sandbox, 'app.js', '// hello\nconst answer = 42;\nconsole.log("hi");\n');
  await seed(request, sandbox, 'Dockerfile', 'FROM node:22\n');
  await seed(request, sandbox, 'notes.xyz', 'just some words');
  await seed(request, sandbox, 'style.css', 'body { color: red; }\n');
  await open(page);

  const [maybeDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 1500 }).catch(() => null),
    row(page, 'app.js').click(),
  ]);
  expect(maybeDownload, 'a .js file must not be downloaded').toBeNull();
  const code = page.getByTestId('code');
  await expect(code).toContainText('const answer = 42;');
  await expect(code.locator('.tk-comment')).toHaveText('// hello');
  await expect(code.locator('.tk-keyword').first()).toHaveText('const');
  await expect(code.locator('.tk-number')).toHaveText('42');
  await expect(code.locator('.tk-string')).toHaveText('"hi"');
  await expect(code.locator('.line')).toHaveCount(4);

  await page.keyboard.press('ArrowRight'); // next previewable file, in list order
  await expect(page.locator('.preview-title strong')).not.toHaveText('app.js');
  await page.keyboard.press('Escape');

  await row(page, 'notes.xyz').click(); // unknown extension, but it is text
  await expect(page.getByTestId('code')).toContainText('just some words');
  await page.keyboard.press('Escape');
  await row(page, 'Dockerfile').click();
  await expect(page.getByTestId('code')).toContainText('FROM node:22');
});

test('an unknown binary file is downloaded, not shown as garbage', async ({ page, request }) => {
  await request.post(`/api/upload?${new URLSearchParams({ path: sandbox, name: 'thing.xyz', id: 'binseed01', offset: 0, total: 4 })}`, { data: Buffer.from([0, 1, 2, 3]), headers: { 'Content-Type': 'application/octet-stream' } });
  await open(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), row(page, 'thing.xyz').click()]);
  expect(dl.suggestedFilename()).toBe('thing.xyz');
  await expect(page.locator('dialog')).toHaveCount(0);
});

test('long text files are cut with a note and a way to get the rest', async ({ page, request }) => {
  const lines = Array.from({ length: 6200 }, (_, i) => `line ${i + 1}`).join('\n');
  await seed(request, sandbox, 'long.log', lines);
  await open(page);
  await row(page, 'long.log').click();
  await expect(page.getByTestId('code').locator('.line')).toHaveCount(5000);
  await expect(page.locator('.preview-note')).toContainText('first 5,000 lines');
});

test('plays video and audio inline, and says so when a format cannot play', async ({ page, request }) => {
  await seed(request, sandbox, 'broken.mp4', 'this is not really a video');
  await open(page);
  await row(page, 'broken.mp4').click();
  await expect(page.getByTestId('preview-fail')).toContainText("can't play");
  await expect(page.getByTestId('preview-fail').getByRole('link', { name: 'Download' })).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

  test('the menu opens and closes, and the page never scrolls sideways', async ({ page, request }) => {
    await seed(request, sandbox, 'a-very-long-file-name-that-should-be-cut-off-nicely-instead-of-breaking-the-layout.txt', 'x');
    await open(page);
    await expect(page.locator('#sidebar')).not.toBeInViewport();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator('#sidebar')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Dark mode' })).toBeVisible();
    await page.locator('#scrim').click({ position: { x: 360, y: 400 } });
    await expect(page.locator('#sidebar')).not.toBeInViewport();
    expect(await noSidewaysScroll(page)).toBe(true);
    await expect(rows(page)).toHaveCount(1);
  });

  test('the + button offers upload, upload folder and new folder', async ({ page, request }) => {
    await open(page);
    await expect(page.locator('#actions-default')).toBeHidden(); // desktop buttons are replaced
    await page.getByRole('button', { name: 'Add files or a folder' }).tap();
    await expect(page.getByRole('menuitem')).toHaveText(['Upload files', 'Upload a folder', 'New folder']);
    await page.getByRole('menuitem', { name: 'New folder' }).tap();
    await page.getByLabel('Folder name').fill('From my phone');
    await page.locator('#dlg-ok').tap();
    await expect(row(page, 'From my phone')).toBeVisible();

    await page.locator('#file-input').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(5000, 1) });
    await expect(row(page, 'photo.jpg')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  });

  test('selecting shows a bottom action bar that fits the screen', async ({ page, request }) => {
    await seed(request, sandbox, 'one.txt', '1');
    await seed(request, sandbox, 'two.txt', '2');
    await open(page);
    const fab = page.getByRole('button', { name: 'Add files or a folder' });
    await expect(fab).toBeVisible();
    await row(page, 'one.txt').getByRole('checkbox').tap();
    await expect(fab).toBeHidden();
    const bar = page.locator('#actions-selected');
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box.y + box.height).toBeCloseTo(844, 0); // sits at the bottom edge
    expect(box.x).toBe(0);
    expect(box.width).toBe(390);
    for (const name of ['Download', 'Rename', 'Delete', 'Clear selection']) {
      const b = await bar.getByRole('button', { name, exact: true }).boundingBox();
      expect(b.width, `${name} is easy to tap`).toBeGreaterThanOrEqual(40);
      expect(b.height).toBeGreaterThanOrEqual(40);
    }
    await page.getByRole('button', { name: 'Clear selection' }).tap();
    await expect(bar).toBeHidden();
  });

  test('filtering, grid view, long names and the viewer all fit', async ({ page, request }) => {
    await seed(request, sandbox, 'very-long-name-'.repeat(8) + '.js', 'const x = "' + 'long '.repeat(80) + '";\n');
    await seed(request, sandbox, 'short.txt', 'x');
    await open(page);
    await page.getByRole('button', { name: 'Show filter' }).tap();
    await page.getByLabel('Filter this folder').fill('short');
    await expect(rows(page)).toHaveCount(1);
    await page.getByLabel('Filter this folder').fill('');
    await page.getByRole('button', { name: 'Switch view' }).tap();
    await expect(page.getByTestId('listing')).toHaveClass(/grid/);
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.locator('[data-testid=row][data-name$=".js"]').tap();
    await expect(page.getByTestId('code')).toContainText('long long');
    // long lines wrap instead of scrolling sideways
    expect(await page.getByTestId('code').evaluate((el) => el.parentElement.scrollWidth <= el.parentElement.clientWidth + 1)).toBe(true);
    expect(await noSidewaysScroll(page)).toBe(true);
  });

  test('theme and hidden files can be changed from the menu', async ({ page, request }) => {
    await seed(request, sandbox, '.hidden-note', 'x');
    await open(page);
    await expect(rows(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Open menu' }).tap();
    await page.getByRole('button', { name: 'Show hidden files' }).tap();
    await page.locator('#scrim').tap({ position: { x: 360, y: 400 } });
    await expect(row(page, '.hidden-note')).toBeVisible();
    await page.getByRole('button', { name: 'Open menu' }).tap();
    await page.getByRole('button', { name: 'Dark mode' }).tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Light mode' })).toBeVisible();
  });

  test('the sign-in page fits a phone and does not zoom in on the field', async ({ page }) => {
    await page.goto(process.env.AUTH_URL || 'http://127.0.0.1:4178');
    const input = page.getByLabel('Password');
    await expect(input).toBeVisible();
    expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16); // 16px stops iOS zooming
    expect(await noSidewaysScroll(page)).toBe(true);
  });
});

test.describe('on a tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });

  test('uses the drawer menu but keeps the date column', async ({ page, request }) => {
    await seed(request, sandbox, 'report.txt', 'x');
    await open(page);
    await expect(page.locator('#sidebar')).not.toBeInViewport();
    await expect(page.getByRole('button', { name: 'Add files or a folder' })).toBeVisible();
    await expect(row(page, 'report.txt').locator('.modified')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe('on a laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('shows the sidebar and the desktop buttons, not the phone ones', async ({ page }) => {
    await open(page);
    await expect(page.locator('#sidebar')).toBeInViewport();
    await expect(page.locator('#btn-upload')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add files or a folder' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
  });
});

test('has no console errors while browsing', async ({ page, request }) => {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await seed(request, sandbox, 'a.txt', 'a');
  await open(page);
  await row(page, 'a.txt').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Switch view' }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(rows(page)).toHaveCount(1);
  expect(errors).toEqual([]);
});
