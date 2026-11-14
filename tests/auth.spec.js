// Password screen, sign out and the 5-wrong-tries block, in a real browser.
const { test, expect } = require('@playwright/test');

const URL = process.env.AUTH_URL || 'http://127.0.0.1:4178';
const PASSWORD = process.env.AUTH_PASSWORD || 'open sesame';
let n = 0;

// Every test is a different visitor (own address), so blocking one never affects another.
test.beforeEach(async ({ context }) => {
  n += 1;
  await context.setExtraHTTPHeaders({ 'X-Forwarded-For': `10.9.${Math.floor(n / 250)}.${(n % 250) + 1}` });
});
test.use({ baseURL: URL });

const fill = async (page, pw) => {
  await page.getByLabel('Password').fill(pw);
  await page.getByRole('button', { name: 'Unlock' }).click();
};

test('asks for the password first and shows nothing else', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hopper' })).toBeVisible();
  await expect(page.getByLabel('Password')).toBeFocused();
  await expect(page.getByTestId('listing')).toHaveCount(0);
  await expect(page).toHaveTitle(/Sign in/);
});

test('a wrong password says how many tries are left; the right one opens the app', async ({ page }) => {
  await page.goto('/');
  await fill(page, 'wrong one');
  await expect(page.getByRole('alert')).toHaveText('Wrong password. 4 tries left.');
  await expect(page.getByLabel('Password')).toHaveValue('');
  await fill(page, 'wrong two');
  await expect(page.getByRole('alert')).toHaveText('Wrong password. 3 tries left.');

  await fill(page, PASSWORD);
  await expect(page.getByTestId('breadcrumb')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await page.reload(); // stays signed in
  await expect(page.getByTestId('breadcrumb')).toBeVisible();
});

test('sign out brings the password screen back', async ({ page }) => {
  await page.goto('/');
  await fill(page, PASSWORD);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
  await page.goBack().catch(() => {});
  await page.reload();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('a deep link asks for the password, then opens that folder', async ({ page }) => {
  await page.goto('/#/');
  await fill(page, PASSWORD);
  await expect(page.getByTestId('breadcrumb')).toBeVisible();
  await expect(page).toHaveURL(/#\//);
});

test('five wrong passwords block this browser, and it stays blocked', async ({ page, context }) => {
  await page.goto('/');
  for (let i = 4; i >= 1; i--) {
    await fill(page, `bad ${i}`);
    await expect(page.getByRole('alert')).toContainText(`${i} ${i === 1 ? 'try' : 'tries'} left`);
  }
  await fill(page, 'bad 5');
  await expect(page.getByRole('heading', { name: 'Access blocked' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Access blocked' })).toBeVisible();

  // even a fresh browser window on the same address is blocked
  const second = await context.browser().newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `10.9.${Math.floor(n / 250)}.${(n % 250) + 1}` } });
  const other = await second.newPage();
  await other.goto(URL + '/');
  await expect(other.getByRole('heading', { name: 'Access blocked' })).toBeVisible();
  await second.close();
});
