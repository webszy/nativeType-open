import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { connectCurrentChrome } from './connect-current-chrome';

const extensionRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = extensionRoot;
const extensionDirectory = path.join(extensionRoot, 'dist', 'chrome-mv3');
const outputDirectory = path.join(extensionRoot, 'store-assets', 'screenshots');
const viewport = { width: 1280, height: 800 };
const source = '今天终于把 NativeType 的第一个版本做完了。';
const defaultTranslation = 'Finally finished the first version of NativeType today.';
// Match platforms/x.ts and ui/overlay.ts; Playwright pierces the open shadow root.
const composerSelector = '[contenteditable="true"][role="textbox"][data-testid^="tweetTextarea_"]';
const previewSelector = '[data-nativetype="preview"]';
const screenshotNames = ['01-write.png', '02-preview.png', '03-replace.png'] as const;

const { values } = parseArgs({
  options: {
    browser: { type: 'string', default: 'chrome' },
    executable: { type: 'string' },
    profile: { type: 'string' },
    connect: { type: 'boolean', default: false },
    cdp: { type: 'string' },
    'chrome-data-dir': { type: 'string' },
    headless: { type: 'boolean', default: false },
    'login-timeout': { type: 'string', default: '600000' },
    'translation-timeout': { type: 'string', default: '600000' },
    'expected-translation': { type: 'string', default: defaultTranslation },
    help: { type: 'boolean', short: 'h' },
  },
});
const translation = values['expected-translation']!;

function timeout(value: string, option: string): number {
  const milliseconds = Number(value);
  assert(Number.isSafeInteger(milliseconds) && milliseconds > 0, `${option} must be a positive integer in milliseconds.`);
  return milliseconds;
}

function inside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function profileDirectory(): string {
  // Keep cookies, credentials and Chrome's translation models out of the repository.
  const cache = process.env.XDG_CACHE_HOME || (process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Caches')
    : process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
      : path.join(homedir(), '.cache'));
  const project = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 12);
  const directory = path.resolve(repositoryRoot, values.profile || path.join(cache, 'NativeType', 'store-screenshots', project, values.browser!));
  if (inside(repositoryRoot, directory)) {
    assert(inside(path.join(repositoryRoot, '.cache', 'store-screenshots'), directory),
      'An in-repository profile must be under .cache/store-screenshots/ (gitignored). Prefer the default external cache.');
  }
  return directory;
}

function build(): void {
  console.log('Building NativeType for Chrome (production Manifest V3)…');
  const pnpm = process.env.npm_execpath;
  const result = pnpm
    ? spawnSync(process.execPath, [pnpm, 'run', 'build'], { cwd: extensionRoot, stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build'], {
      cwd: extensionRoot, stdio: 'inherit', shell: process.platform === 'win32',
    });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'The production build failed; no screenshots were captured.');
}

async function existingChromeEndpoint(): Promise<string> {
  if (values.cdp) {
    const url = new URL(values.cdp);
    assert(['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password, '--cdp must be a local Chrome debugging URL without credentials.');
    return url.href;
  }
  const directory = values['chrome-data-dir'] || (process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'google-chrome'));
  // Chrome 144+'s user-approved debugging server does not expose /json/version.
  // Read only its endpoint file, never cookies, passwords or other profile data.
  let endpoint: string;
  try {
    endpoint = await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8');
  } catch {
    throw new Error('Current Chrome debugging is not enabled. Open chrome://inspect/#remote-debugging, enable "Allow remote debugging for this browser instance", then run --connect again.');
  }
  const [port, browserPath] = endpoint.trim().split(/\r?\n/);
  assert(port && /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535
    && browserPath?.startsWith('/devtools/browser/'), 'Chrome has an invalid debugging endpoint. Re-enable remote debugging and retry.');
  return `ws://127.0.0.1:${port}${browserPath}`;
}

async function editorText(editor: Locator): Promise<string> {
  return editor.evaluate(element => {
    const blocks = element.querySelectorAll<HTMLElement>('[data-block="true"]');
    const text = blocks.length
      ? Array.from(blocks, block => block.innerText.replace(/\n$/, '')).join('\n')
      : (element as HTMLElement).innerText;
    return text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
  });
}

async function waitForText(editor: Locator, expected: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await editorText(editor) === expected) return;
    await delay(100);
  }
  assert.equal(await editorText(editor), expected, 'X did not retain the expected composer text.');
}

async function openComposer(page: Page, loginTimeout: number, headless: boolean): Promise<Locator> {
  console.log(headless
    ? 'Opening X in headless Chrome using the saved login. If authentication is needed, rerun without --headless.'
    : `Opening X. If prompted, sign in manually in the capture window (up to ${Math.ceil(loginTimeout / 60_000)} minutes).`);
  console.log('The workflow resumes automatically when the New Post composer is available. It never clicks Post.');
  try {
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(`X navigation failed: ${reason}. ${headless
      ? 'Rerun without --headless and complete any login or site challenges manually.'
      : 'Check connectivity and whether X is available in desktop Chrome, then retry.'}`);
  }
  const editor = page.locator('[role="dialog"]').locator(composerSelector).first();
  const composeLink = page.locator('a[href="/compose/post"]:visible').first();
  const deadline = Date.now() + loginTimeout;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('The capture window was closed before X was ready.');
    if (await editor.isVisible()) return editor;
    // X can redirect to Home after login. Open the real New Post dialog there.
    // X renders the page behind a composer/login mask before its editor is ready.
    // Only reopen from Home once no modal is covering the navigation link.
    if (new URL(page.url()).pathname === '/home'
      && await page.locator('[role="dialog"]:visible').count() === 0
      && await composeLink.isVisible()) {
      try {
        await composeLink.click({ timeout: 5_000 });
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
      }
    }
    await delay(500);
  }
  throw new Error('X login/composer timed out. Run again without --headless and finish login in the dedicated capture window. Use --login-timeout to allow more time.');
}

async function waitForTranslation(preview: Locator, translationTimeout: number): Promise<void> {
  const replace = preview.getByRole('button', { name: 'Replace', exact: true });
  const enable = preview.getByRole('button', { name: 'Enable translation', exact: true });
  const retry = preview.getByRole('button', { name: 'Retry', exact: true });
  const status = preview.getByRole('status');
  let enabled = false;
  let retries = 0;
  let lastStatus = '';
  const deadline = Date.now() + translationTimeout;
  while (Date.now() < deadline) {
    if (await replace.isVisible()) {
      const actual = (await status.innerText()).trim();
      assert.equal(actual, translation,
        'Chrome returned a different translation. No screenshot set will be saved; the workflow does not substitute or mock the expected English.');
      return;
    }
    if (await enable.isVisible()) {
      if (enabled) throw new Error('Chrome still requires translation activation. Check model downloads/policies and retry in current desktop Google Chrome.');
      console.log('Activating NativeType’s real Chrome translator; the first model download can take several minutes…');
      await enable.click();
      enabled = true;
    } else if (await preview.isVisible()) {
      const current = (await status.innerText()).trim();
      if (current !== lastStatus) {
        console.log(`NativeType: ${current}`);
        lastStatus = current;
      }
      if (/unavailable|not supported/i.test(current)) {
        throw new Error(`${current} Use current desktop Google Chrome with its built-in Translator available. Chromium builds may lack language models.`);
      }
      if (await retry.isVisible()) {
        if (retries++ >= 2) throw new Error(`NativeType could not translate: ${current}`);
        await delay(1_000);
        await retry.click();
      }
    }
    await delay(200);
  }
  throw new Error(`Translation timed out (${lastStatus || 'no preview'}). Check Chrome’s language-pack download and connection, or increase --translation-timeout.`);
}

async function settle(page: Page, anchors: Locator[]): Promise<void> {
  await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 30_000 });
  await page.mouse.move(viewport.width - 8, viewport.height - 8);
  let previous = '';
  let stableSince = Date.now();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const boxes = await Promise.all(anchors.map(anchor => anchor.boundingBox()));
    assert(boxes.every(box => box !== null), 'A required screenshot element is not visible.');
    for (const box of boxes) {
      assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
        'A required screenshot element is clipped. Make the composer/preview fully visible and run again.');
    }
    const current = JSON.stringify(boxes);
    const animating = await page.evaluate(() => document.getAnimations().some(animation =>
      animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity));
    if (current !== previous || animating) stableSince = Date.now();
    if (Date.now() - stableSince >= 500) return;
    previous = current;
    await delay(100);
  }
  throw new Error('Composer/preview layout or animations did not settle within 10 seconds.');
}

async function capture(page: Page, directory: string, name: string, editor: Locator, expectedText: string, previewVisible: boolean): Promise<void> {
  // Collapse X's selection with an ordinary key so its formatting toolbar is
  // dismissed. Do not hide native UI with styles or change the draft content.
  await editor.press('ArrowRight');
  const preview = page.locator(previewSelector);
  const anchors = [editor];
  if (previewVisible) anchors.push(preview.getByRole('region', { name: 'NativeType translation' }));
  await settle(page, anchors);
  assert.equal(await editorText(editor), expectedText);
  assert.equal(await preview.isVisible(), previewVisible, 'NativeType preview is in the wrong screenshot state.');
  if (previewVisible) {
    assert.equal((await preview.getByRole('status').innerText()).trim(), translation);
    assert(await preview.getByRole('button', { name: 'Replace', exact: true }).isVisible());
  }
  // Render the live X page + real extension. No mock DOM, injected styles or resized images.
  const png = await page.screenshot({
    path: path.join(directory, name), type: 'png', fullPage: false,
    scale: 'css', animations: 'disabled', caret: 'hide',
  });
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Expected a PNG screenshot.');
  assert.equal(png.readUInt32BE(16), viewport.width, `${name} has the wrong PNG width.`);
  assert.equal(png.readUInt32BE(20), viewport.height, `${name} has the wrong PNG height.`);
  console.log(`Captured ${name}: ${viewport.width} × ${viewport.height}`);
}

async function main(): Promise<void> {
  if (values.help) {
    console.log(`Usage: pnpm screenshot:store [options]

Builds NativeType, opens X in a persistent browser, and captures three 1280x800 PNGs.
  --browser chrome|chromium     Default: installed Google Chrome (recommended for Translator)
  --executable PATH            Use a specific Chrome/Chromium executable
  --profile PATH               Dedicated persistent profile; default: external OS cache
  --connect                    Attach to your running Chrome; approve its connection dialog
  --cdp URL                    Attach to an explicit local CDP URL (implies --connect)
  --chrome-data-dir PATH        Locate DevToolsActivePort for a non-default Chrome data directory
  --headless                   Optional, after login; default: headed
  --login-timeout MS            Default: 600000 (10 minutes)
  --translation-timeout MS      Default: 600000 (10 minutes)
  --expected-translation TEXT   Validate this exact real Chrome translation instead
  --help                       Show this help without building or launching

Output: ${outputDirectory}
No post is published and no authentication data is exported.`);
    return;
  }
  assert(values.browser === 'chrome' || values.browser === 'chromium', '--browser must be chrome or chromium.');
  const attaching = values.connect || Boolean(values.cdp);
  assert(!attaching || (!values.headless && !values.profile && !values.executable),
    '--connect cannot be combined with --headless, --profile or --executable; it uses the existing Chrome instance.');
  assert(attaching || !values['chrome-data-dir'], '--chrome-data-dir requires --connect.');
  const loginTimeout = timeout(values['login-timeout']!, '--login-timeout');
  const translationTimeout = timeout(values['translation-timeout']!, '--translation-timeout');
  assert(translation.trim() === translation && translation.length > 0,
    '--expected-translation must be non-empty, without leading/trailing whitespace. It validates Chrome output; it never substitutes it.');
  const endpoint = attaching ? await existingChromeEndpoint() : undefined;
  const profile = attaching ? undefined : profileDirectory();
  build();
  const manifest = JSON.parse(await readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8')) as { name: string; manifest_version: number };
  assert.equal(manifest.name, 'NativeType');
  assert.equal(manifest.manifest_version, 3);
  let context: BrowserContext;
  let attachedBrowser: Browser | undefined;
  let attachedPage: Page | undefined;
  if (endpoint) {
    console.log('Connecting to your running Chrome. Approve Chrome’s remote debugging dialog if prompted.');
    const connection = await connectCurrentChrome(endpoint, loginTimeout);
    attachedBrowser = connection.browser;
    attachedPage = connection.page;
    const existingContext = attachedBrowser.contexts()[0];
    if (!existingContext) {
      await attachedBrowser.close();
      throw new Error('The connected Chrome has no existing profile context.');
    }
    context = existingContext;
  } else {
    assert(profile);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    console.log(`Persistent browser profile (private; never commit): ${profile}`);
    context = await chromium.launchPersistentContext(profile, {
      ...(values.executable ? { executablePath: path.resolve(values.executable) } : { channel: values.browser }),
      headless: values.headless, viewport, deviceScaleFactor: 1,
      locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce',
      // Playwright normally disables extensions and Chrome's component/model downloads.
      ignoreDefaultArgs: ['--disable-extensions', '--disable-component-update', '--disable-background-networking'],
      args: ['--enable-unsafe-extension-debugging', '--window-size=1280,900', '--force-color-profile=srgb'],
    });
  }
  // Closing a CDP-attached Browser disconnects its transport; never close the
  // user's default context, which would close their real Chrome and other tabs.
  const disconnect = () => attachedBrowser ? attachedBrowser.close() : context.close();
  let staging: string | undefined;
  let editor: Locator | undefined;
  let capturePage: Page | undefined = attachedPage;
  let ownsDemo = false;
  let cleaningUp: Promise<void> | undefined;
  const cleanup = () => cleaningUp ||= (async () => {
    // Clear only our known demo; never clear a developer's unrelated edits.
    if (ownsDemo && editor) {
      try {
        const current = await editorText(editor);
        if (current === source || current === translation) await editor.fill('');
      } catch { /* The developer may have already closed the capture window. */ }
    }
    if (staging) await rm(staging, { recursive: true, force: true });
    if (capturePage && !capturePage.isClosed()) await capturePage.close().catch(() => {});
    await disconnect();
  })();
  const interrupt = () => { process.exitCode = 130; void cleanup().catch(() => {}); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    // Current branded Chrome removed --load-extension. Its supported CDP command
    // works with --enable-unsafe-extension-debugging and loads the WXT build unchanged.
    const browser = context.browser();
    assert(browser, 'Could not access the persistent Chromium browser.');
    const cdp = await browser.newBrowserCDPSession();
    let loadDirectory = extensionDirectory;
    try {
      if (attaching) {
        const installed = (await cdp.send('Extensions.getExtensions')).extensions
          .filter(extension => extension.name === 'NativeType' && extension.enabled);
        assert(installed.length <= 1, 'Multiple NativeType installations are enabled. Keep one enabled before capturing.');
        if (installed[0] && path.resolve(installed[0].path) !== extensionDirectory) {
          // Reuse this project's older WXT output path, preserving its extension ID.
          // Copy only the actual production build, never any browser/profile files.
          const legacyDirectory = path.join(repositoryRoot, '.output', 'chrome-mv3');
          assert.equal(path.resolve(installed[0].path), legacyDirectory,
            `NativeType is loaded from another directory. Load ${extensionDirectory} instead, with only one NativeType enabled.`);
          assert(inside(await realpath(repositoryRoot), await realpath(legacyDirectory)), 'The legacy extension output must be inside this project.');
          await cp(extensionDirectory, legacyDirectory, { recursive: true, force: true });
          loadDirectory = legacyDirectory;
          console.log('Updating the existing NativeType installation with the real production WXT build.');
        }
      }
      const extension = await cdp.send('Extensions.loadUnpacked', { path: loadDirectory });
      console.log(`Loaded production NativeType (${extension.id}) in ${browser.version()}.`);
    } catch (error) {
      if (!attaching) {
        throw new Error('Could not load NativeType with Extensions.loadUnpacked. Update desktop Chrome, or install Playwright Chromium with pnpm exec playwright install chromium and use --browser chromium.', { cause: error });
      }
      // A normally launched Chrome may disallow extension installation over CDP.
      // Accept only the enabled unpacked NativeType from this production build.
      let extensions;
      try {
        extensions = (await cdp.send('Extensions.getExtensions')).extensions;
      } catch {
        throw new Error(`Current Chrome cannot verify/load the production extension over CDP. Load ${extensionDirectory} manually in chrome://extensions, or use the default dedicated-browser workflow.`, { cause: error });
      }
      const installed = extensions.filter(extension => extension.name === 'NativeType' && extension.enabled);
      assert.equal(installed.length, 1, 'Keep exactly one enabled NativeType installation before capturing.');
      assert.equal(path.resolve(installed[0]!.path), loadDirectory, `Load the freshly built ${extensionDirectory} in chrome://extensions before using --connect.`);
      console.log(`Using installed production NativeType (${installed[0]!.id}) in ${browser.version()}.`);
    } finally {
      await cdp.detach();
    }
    const page = attachedPage || context.pages()[0] || await context.newPage();
    if (attaching) {
      capturePage = page;
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    }
    page.setDefaultTimeout(15_000);
    if (!values.headless) await page.bringToFront();
    editor = await openComposer(page, loginTimeout, values.headless);
    await page.locator(previewSelector).waitFor({ state: 'attached' });
    const existingText = await editorText(editor);
    assert(!existingText.trim() || existingText === source || existingText === translation,
      'The X composer contains an existing draft. Save or clear it manually, then rerun; NativeType will not overwrite it.');
    await editor.fill('');
    await settle(page, [editor]);
    ownsDemo = true;
    await editor.fill(source);
    await waitForText(editor, source);
    const preview = page.locator(previewSelector);
    // Use NativeType's real Close action to cancel the pending translation. This
    // avoids racing its one-second debounce or hiding the UI with screenshot CSS.
    await preview.waitFor({ state: 'visible' });
    await preview.getByRole('button', { name: 'Close translation preview', exact: true }).click();
    await preview.waitFor({ state: 'hidden' });
    await mkdir(outputDirectory, { recursive: true });
    staging = await mkdtemp(path.join(outputDirectory, '.capture-'));
    await capture(page, staging, screenshotNames[0], editor, source, false);

    // An ordinary edit restarts the production debounce (or reuses its real cache).
    // The source and composer remain the same after removing the added space.
    await editor.press('ArrowRight');
    await page.keyboard.insertText(' ');
    await editor.press('Backspace');
    await waitForText(editor, source);
    await waitForTranslation(preview, translationTimeout);
    await capture(page, staging, screenshotNames[1], editor, source, true);

    await preview.getByRole('button', { name: 'Replace', exact: true }).click();
    await waitForText(editor, translation);
    await preview.waitFor({ state: 'hidden' });
    await capture(page, staging, screenshotNames[2], editor, translation, false);
    // Keep the previous set intact if login, translation or replacement fails.
    for (const name of screenshotNames) await rename(path.join(staging, name), path.join(outputDirectory, name));
    console.log(`Saved all three verified ${viewport.width} × ${viewport.height} screenshots to ${outputDirectory}`);
  } finally {
    await cleanup();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode ||= 1;
});
