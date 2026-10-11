import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(`${page.url()}: ${error.stack || error.message}`)));
const base = process.env.RELAY_PREVIEW_URL || 'http://127.0.0.1:5173';

try {
  const setup = await context.newPage();
  await setup.goto(`${base}/?demo=1&setup=1`);
  await expect(setup.getByRole('heading', { name: 'Choose your starting folder.' })).toBeVisible();
  await expect(setup.getByLabel('Agent', { exact: true })).toHaveCount(0);
  await expect(setup.getByLabel('Model', { exact: true })).toHaveCount(0);
  await expect(setup.getByRole('dialog')).toHaveCount(0);
  await setup.screenshot({ path: 'artifacts/relay-setup.png' });
  await setup.getByLabel('Working folder', { exact: true }).fill('C:\\Projects\\preview');
  await setup.getByRole('button', { name: 'Open terminal', exact: true }).click();
  await expect(setup.getByRole('heading', { name: 'Terminal 1', exact: true })).toBeVisible();
  await expect(setup.locator('.terminal-host .xterm')).toBeVisible();
  await expect(setup.getByRole('button', { name: 'Rename group Group 1', exact: true })).toBeVisible();
  await setup.getByRole('button', { name: 'New tab Ctrl N', exact: true }).click();
  await expect(setup.getByRole('heading', { name: 'Terminal 2', exact: true })).toBeVisible();
  await expect(setup.getByRole('dialog')).toHaveCount(0);
  await setup.reload();
  await expect(setup.getByRole('heading', { name: 'Terminal 2', exact: true })).toBeVisible();
  await expect(setup.getByRole('heading', { name: 'Choose your starting folder.' })).toHaveCount(0);
  await setup.close();

  const page = await context.newPage();
  await page.goto(`${base}/?demo=1`);
  await expect(page.getByRole('heading', { name: 'Terminal 1', exact: true })).toBeVisible();
  await expect(page.locator('.terminal-host .xterm')).toBeVisible();
  await page.screenshot({ path: 'artifacts/relay-preview.png' });
  await page.getByRole('button', { name: 'Rename group Group 1', exact: true }).click();
  await page.getByRole('textbox', { name: 'Group name', exact: true }).fill('Project work');
  await page.getByRole('textbox', { name: 'Group name', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Rename group Project work', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Collapse Project work', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand Project work', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand Project work', exact: true }).click();
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rename group Group 3', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rename group Group 3', exact: true }).click();
  await page.getByRole('textbox', { name: 'Group name', exact: true }).fill('QA group');
  await page.getByRole('textbox', { name: 'Group name', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'New tab in QA group', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Terminal 4', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('heading', { name: 'Terminal 5', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/relay-shell-tabs.png' });

  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/relay-inbox.png' });
  await page.getByRole('button', { name: 'Open session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Investigate the build failure', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByRole('heading', { name: 'Build investigation ready', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /^Background rules/ }).click();
  await expect(page.getByRole('heading', { name: 'Background rules', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/relay-rules.png' });
  await page.getByRole('button', { name: 'New rule', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: 'artifacts/relay-rule-editor.png' });
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Rename group QA group', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 640 });
  await page.getByRole('button', { name: 'New tab Ctrl N', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Terminal 6', exact: true })).toBeVisible();
  await expect(page.locator('.terminal-host .xterm')).toBeVisible();
  await page.screenshot({ path: 'artifacts/relay-small-preview.png' });
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page.screenshot({ path: 'artifacts/relay-small-inbox.png' });
  await page.getByRole('button', { name: /^Background rules/ }).click();
  await page.getByRole('button', { name: 'New rule', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: 'artifacts/relay-small-rule-editor.png' });
  const modalBox = await page.locator('.modal').boundingBox();
  if (!modalBox || modalBox.x < 23 || modalBox.y < 23 || modalBox.x + modalBox.width > 877 || modalBox.y + modalBox.height > 617) throw new Error('The small rule dialog extends beyond its viewport.');
  await page.getByRole('button', { name: 'Save rule', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Save rule', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('The small layout overflows the browser horizontally.');

  const runtime = await context.newPage();
  await runtime.goto(base);
  await expect(runtime.getByText('Relay needs its desktop runtime to manage local terminals. Launch the installed Relay application.')).toBeVisible();
  await expect(runtime.locator('.terminal-host')).toHaveCount(0);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Preview checks passed: folder-only setup once across reload, direct shell tabs/button/shortcut, inline group rename and separate collapse, retained inbox, rules, 900x640 layouts, explicit runtime requirement; no page errors.');
} finally {
  await browser.close();
}
