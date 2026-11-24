import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, Locator, Page } from 'playwright';

const chinese = '今天终于做完了nativeType的商业变现版本。';
const english = 'Today I finally finished the monetized version of nativeType.';
const names = ['01-write.png', '02-preview.png', '03-ai-loading.png'];

// Briefly pause only NativeType's worker so the real pending AI state can be
// photographed reliably, even when license validation responds immediately.
// No response, entitlement, translation, or UI is substituted. Always resume.
async function pauseWorker(browser: Browser, extensionId: string): Promise<() => Promise<void>> {
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const worker = targetInfos.find(target => target.type === 'service_worker'
    && target.url.startsWith(`chrome-extension://${extensionId}/`));
  assert(worker, 'NativeType worker is not running.');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: false });
  let id = 0;
  let paused = false;
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.method === 'Debugger.paused') paused = true;
    if (message.method === 'Debugger.resumed') paused = false;
  });
  const command = async (method: string) => {
    const requestId = ++id;
    const response = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', receive); reject(new Error(`${method} timed out`)); }, 10_000);
      const receive = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== requestId) return;
        clearTimeout(timer);
        cdp.off('Target.receivedMessageFromTarget', receive);
        if (message.error) reject(new Error(message.error.message));
        else resolve();
      };
      cdp.on('Target.receivedMessageFromTarget', receive);
    });
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: requestId, method }) });
    await response;
  };
  try {
    await command('Debugger.enable');
    await command('Debugger.pause');
    console.log('Requested a temporary pause of NativeType’s worker for the loading capture.');
  } catch (error) {
    await cdp.detach();
    throw error;
  }
  return async () => {
    try { if (paused) await command('Debugger.resume'); }
    finally { await cdp.detach(); }
  };
}

export async function captureCommercialScreenshots({ page, browser, extensionId, outputDirectory, viewport, openComposer }: {
  page: Page; browser: Browser; extensionId: string; outputDirectory: string;
  viewport: { width: number; height: number }; openComposer(): Promise<Locator>;
}) {
  const settingsUrl = `chrome-extension://${extensionId}/options.html`;
  const preview = page.locator('[data-nativetype="preview"]');
  let editor: Locator | undefined;
  let owned = false;
  let staging: string | undefined;
  let original: { source: string; target: string; mode: string } | undefined;
  let resume: (() => Promise<void>) | undefined;
  async function settings(source: string, target: string, mode: string) {
    await page.goto(settingsUrl);
    await page.locator('.save-status').filter({ hasText: 'Saved' }).waitFor();
    if (await page.locator('#target-language').inputValue() === source) {
      const currentSource = await page.locator('#source-language').inputValue();
      const intermediate = ['de', 'fr', 'es'].find(language => language !== source && language !== currentSource)!;
      await page.locator('#target-language').selectOption(intermediate);
    }
    await page.locator('#source-language').selectOption(source);
    await page.locator('#target-language').selectOption(target);
    await page.locator(`#translation-mode-${mode}`).check();
    await page.locator('.save-status').filter({ hasText: 'Saved' }).waitFor();
  }
  async function compose(text: string) {
    editor = await openComposer();
    const current = (await editor.innerText()).trim();
    assert(!current || current === chinese || current === english, 'An unrelated X draft exists; save it before capturing.');
    owned = true;
    await editor.fill(text);
    await editor.press('ArrowRight');
  }
  async function shot(name: string, expected: string) {
    assert(editor && staging);
    assert.equal((await editor.innerText()).trim(), expected);
    await page.mouse.move(viewport.width - 8, viewport.height - 8);
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    const png = await page.screenshot({ path: path.join(staging, name), type: 'png',
      fullPage: false, scale: 'css', animations: 'disabled', caret: 'hide' });
    assert.equal(png.readUInt32BE(16), viewport.width);
    assert.equal(png.readUInt32BE(20), viewport.height);
    console.log(`Captured ${name}: ${viewport.width} × ${viewport.height}`);
  }
  async function clearDemo() {
    if (owned && editor && await editor.isVisible().catch(() => false)) {
      const text = (await editor.innerText()).trim();
      if (text === chinese || text === english) await editor.fill('');
    }
    owned = false;
  }
  try {
    await page.goto(settingsUrl);
    await page.locator('.save-status').filter({ hasText: 'Saved' }).waitFor();
    original = {
      source: await page.locator('#source-language').inputValue(),
      target: await page.locator('#target-language').inputValue(),
      mode: await page.locator('input[name="translation-mode"]:checked').inputValue(),
    };
    await mkdir(outputDirectory, { recursive: true });
    staging = await mkdtemp(path.join(outputDirectory, '.capture-'));
    await settings('zh', 'en', 'automatic');
    await compose(chinese);
    await preview.waitFor({ state: 'visible', timeout: 60_000 });
    await preview.getByRole('button', { name: 'Close translation preview', exact: true }).click();
    await preview.waitFor({ state: 'hidden' });
    await shot(names[0]!, chinese);
    await clearDemo();

    await settings('en', 'ja', 'automatic');
    await compose(english);
    await preview.waitFor({ state: 'visible', timeout: 60_000 });
    const replace = preview.getByRole('button', { name: 'Replace', exact: true });
    const deadline = Date.now() + 600_000;
    let activated = false;
    while (!await replace.isVisible()) {
      assert(Date.now() < deadline, 'Japanese translation timed out.');
      const enable = preview.getByRole('button', { name: 'Enable translation', exact: true });
      if (await enable.isVisible()) {
        assert(!activated, 'Japanese translation activation failed.');
        await enable.click();
        activated = true;
        console.log('Downloading/activating Chrome’s real English-to-Japanese translator…');
      }
      await delay(200);
    }
    const translated = (await preview.locator('[data-part="result"]').innerText()).trim();
    assert(/[\u3040-\u30ff\u3400-\u9fff]/u.test(translated), 'Expected a real Japanese translation.');
    console.log(`Chrome Japanese translation: ${translated}`);
    await shot(names[1]!, english);

    resume = await pauseWorker(browser, extensionId);
    await preview.getByRole('button', { name: 'Improve with AI', exact: true }).click();
    const loading = preview.locator('[data-part="sparkles-loader"]');
    await loading.waitFor({ state: 'visible' });
    assert.equal(await preview.getByRole('button', { name: 'Improving…', exact: true }).getAttribute('aria-busy'), 'true');
    await shot(names[2]!, english);
    assert(await loading.isVisible(), 'AI loading ended before the capture finished.');
    await resume();
    resume = undefined;
    for (const name of names) await rename(path.join(staging, name), path.join(outputDirectory, name));
    await rm(path.join(outputDirectory, '03-replace.png'), { force: true });
    console.log(`Saved all three commercial screenshots to ${outputDirectory}`);
  } finally {
    if (resume) await resume();
    await clearDemo();
    if (original && !page.isClosed()) await settings(original.source, original.target, original.mode);
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
