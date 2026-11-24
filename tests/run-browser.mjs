import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ executablePath: process.env.NATIVETYPE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const failures = [];
  for (const fixture of ['analytics-browser.html', 'automatic-browser.html', 'browser.html', 'chat-browser.html', 'ai-browser.html']) {
    const page = await browser.newPage({ viewport: { width:1280, height:900 } });
    await page.goto(`http://127.0.0.1:${address.port}/tests/${fixture}`);
    if (fixture === 'browser.html') await page.waitForFunction(() => window.__nativetypeFixtureReady === true);
    await page.locator('#run').click();
    await page.waitForFunction(() => /ALL PASSED|DONE:|FAIL/.test(document.querySelector('#results').textContent), null, { timeout: 120_000 });
    const results = await page.locator('#results').innerText();
    if (results.includes('FAIL')) failures.push(`${fixture}: ${results.slice(results.indexOf('FAIL'))}`);
    process.stdout.write(`${fixture}: ${results.match(/^PASS /gm)?.length ?? 0} checks passed (simulated translation/model and editor state)\n`);
    await page.close();
  }
  assert.deepEqual(failures, [], failures.join('\n'));
} finally {
  await browser?.close();
  await server.close();
}
