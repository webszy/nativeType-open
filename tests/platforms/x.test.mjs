import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTs } from '../load-ts.mjs';
import { installDOM, settle } from '../dom-fixture.mjs';

const { resolvePlatform } = await loadTs('platforms/registry.ts');
const { xPlatform } = await loadTs('platforms/x.ts');
const source = await readFile(new URL('../../platforms/x.ts', import.meta.url), 'utf8');

test('registry resolves only X on x.com', () => {
  assert.equal(resolvePlatform({ hostname: 'x.com' }), xPlatform);
  assert.equal(resolvePlatform({ hostname: 'www.x.com' }), null);
  assert.equal(resolvePlatform({ hostname: 'example.com' }), null);
  assert.equal(xPlatform.id, 'x');
});

test('X keeps the verified selector, paste replacement, and local observer', () => {
  assert.match(source, /\[contenteditable="true"\]\[role="textbox"\]\[data-testid\^="tweetTextarea_"\]/);
  assert.match(source, /\[data-block="true"\]/);
  assert.match(source, /\[role="dialog"\]/);
  assert.match(source, /setTimeout\(resolve, 0\)/);
  assert.match(source, /setTimeout\(resolve, 50\)/);
  assert.match(source, /new MouseEvent\('mouseup'/);
  assert.match(source, /new ClipboardEvent\('paste'/);
  assert.match(source, /requestAnimationFrame/);
  assert.doesNotMatch(source, /innerHTML|textContent\s*=/);
  assert.match(source, /observer\.observe\(editor, \{ childList: true, subtree: true, characterData: true \}\)/);
  assert.match(source, /observer\.observe\(parent, \{ childList: true \}\)/);
  assert.doesNotMatch(source, /document\.body[\s\S]{0,120}subtree:\s*true/);
  assert.doesNotMatch(source, /observe\(\s*document\.body/);
  assert.match(source, /\[data-testid="quoteTweet"\]/);
  assert.match(source, /article\[data-testid="tweet"\]/);
  assert.match(source, /resolveWritingContext/);
  assert.doesNotMatch(source, /innerHTML|textContent\s*=/);
});

test('the X adapter checks replacement permission again after selection settles', async t => {
  const dom = installDOM(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const editor = document.createElement('div');
  editor.innerText = 'Original draft';
  document.body.append(editor);
  let allowed = true;
  let pastes = 0;
  let range;
  const selection = {
    rangeCount: 0,
    removeAllRanges() {},
    addRange(next) { range = next; this.rangeCount = 1; this.anchorNode = editor; this.focusNode = editor; },
    getRangeAt: () => range,
  };
  document.createRange = () => ({ selectNodeContents() {}, toString: () => 'Original draft' });
  window.getSelection = () => selection;
  dom.setGlobal('MouseEvent', class { constructor(type) { this.type = type; } });
  dom.setGlobal('ClipboardEvent', globalThis.MouseEvent);
  dom.setGlobal('DataTransfer', class { setData() {} });
  editor.dispatchEvent = event => { if (event.type === 'paste') pastes += 1; return false; };
  const replacing = xPlatform.replaceText(editor, 'Original draft', 'Translation', () => allowed);
  t.mock.timers.tick(0);
  await settle();
  allowed = false;
  t.mock.timers.tick(50);
  await settle();
  dom.flushFrames();
  assert.equal(await replacing, false);
  assert.equal(pastes, 0);
  assert.equal(editor.innerText, 'Original draft');
});
