// @ts-check
const { defineConfig } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// BASE_URL=http://host:3999 npx playwright test  -> test a server that is already running
const remote = process.env.BASE_URL;
const port = 4177;
const root = path.join(os.tmpdir(), 'fm-e2e-root');
if (!remote) fs.mkdirSync(root, { recursive: true });

// A second server that asks for a password, used by tests/auth.spec.js
// (AUTH_URL=http://host:3998 AUTH_PASSWORD=... to use one that is already running)
const authPort = 4178;
const authRemote = process.env.AUTH_URL;
const authRoot = path.join(os.tmpdir(), 'fm-e2e-auth-root');
if (!authRemote) fs.mkdirSync(authRoot, { recursive: true });

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '*.spec.js',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: remote || `http://127.0.0.1:${port}`,
    // Uses the Chrome that is already installed, so no browser download is needed.
    channel: process.env.PW_CHANNEL || 'chrome',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: path.join(os.tmpdir(), 'fm-e2e-results'),
  webServer: [
    ...(remote ? [] : [{
      command: 'node server.js',
      env: { PORT: String(port), HOST: '127.0.0.1', FM_ROOT: root },
      url: `http://127.0.0.1:${port}/api/info`,
      reuseExistingServer: false,
    }]),
    ...(authRemote ? [] : [{
      command: 'node server.js',
      env: { PORT: String(authPort), HOST: '127.0.0.1', FM_ROOT: authRoot, FM_PASSWORD: 'open sesame', FM_TRUST_PROXY: '1' },
      url: `http://127.0.0.1:${authPort}/`,
      reuseExistingServer: false,
    }]),
  ],
});
