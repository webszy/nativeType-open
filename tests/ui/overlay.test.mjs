import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, settle } from '../dom-fixture.mjs';
import { loadTs } from '../load-ts.mjs';

const { createOverlay } = await loadTs('ui/overlay.ts');
const { xPlatform } = await loadTs('platforms/x.ts');

function composer(document) {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const input = document.createElement('div');
  input.style.display = 'flex';
  input.style.flexDirection = 'column';
  const draft = document.createElement('div');
  const richText = document.createElement('div');
  richText.dataset.testid = 'tweetTextarea_0RichTextInputContainer';
  richText.style.height = '100%';
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.dataset.testid = 'tweetTextarea_0';
  editor.innerText = '原文';
  const toolbar = document.createElement('div');
  toolbar.setAttribute('role', 'toolbar');
  richText.append(editor);
  draft.append(richText);
  input.append(draft);
  dialog.append(input, toolbar);
  document.body.append(dialog);
  return { dialog, input, draft, richText, editor, toolbar };
}

test('the inline preview follows the draft, keeps the toolbar, and renders text safely', async t => {
  const { document, setGlobal } = installDOM(t);
  const computedStyle = getComputedStyle;
  setGlobal('getComputedStyle', element => ({ ...computedStyle(element), display: element.style.display, flexDirection: element.style.flexDirection }));
  const { input, draft, richText, editor, toolbar } = composer(document);
  let retries = 0;
  let replacements = 0;
  let closes = 0;
  const overlay = createOverlay(() => { retries += 1; }, () => { replacements += 1; }, editor => xPlatform.previewLayout(editor), { source: 'zh', target: 'en' }, () => { closes += 1; }, undefined, undefined, {
    logoUrl: 'chrome-extension://test/icon/128.png',
  });
  assert.equal(xPlatform.previewLayout(editor).container, input);
  overlay.show(editor, { kind: 'translated', text: '<b>Hello</b>\nthere' });
  assert.equal(overlay.host.parentElement, input);
  assert.equal(draft.nextSibling, overlay.host);
  assert.equal(richText.contains(overlay.host), false);
  assert.equal(richText.style.height, '100%');
  assert.equal(input.nextSibling, toolbar);
  assert.equal(document.body.querySelectorAll('[data-nativetype]').length, 1);
  assert.match(overlay.host.style.cssText, /position:static/);
  assert.doesNotMatch(overlay.host.style.cssText, /position:\s*(?:fixed|absolute)/);
  assert.equal(overlay.host.hasAttribute('popover'), false);
  const root = overlay.host.shadowRoot;
  const result = root.querySelector('[data-part="result"]');
  assert.equal(result.textContent, '<b>Hello</b>\nthere');
  assert.equal(result.lang, 'en');
  assert.equal(root.querySelector('[data-part="name"]').textContent, 'NativeType');
  assert.equal(root.querySelector('[data-part="language"]').textContent, 'English');
  assert.equal(root.querySelector('[data-part="logo"]').getAttribute('src'), 'chrome-extension://test/icon/128.png');
  assert.equal(root.querySelector('[data-part="logo"]').hidden, false);
  assert.equal(root.querySelector('[data-part="plan"]').hidden, true);
  assert.equal(root.querySelectorAll('img').length, 1);
  assert.equal(editor.style.getPropertyValue('min-height'), '');
  overlay.show(editor, { kind: 'translating', text: 'Translating…' });
  assert.equal(input.querySelectorAll('[data-nativetype]').length, 1);
  assert.equal(root.querySelector('[data-part="spinner"]').hidden, false);
  assert.equal(root.querySelector('[data-part="result"]').textContent, 'Translating…');
  const replace = [...root.querySelectorAll('button')].find(button => button.textContent === 'Replace');
  assert.equal(replace.hidden, true);
  overlay.show(editor, { kind: 'error', text: 'Translation failed. Please retry.' });
  const retry = [...root.querySelectorAll('button')].find(button => button.textContent === 'Retry');
  assert.equal(replace.hidden, true);
  await retry.fire('click');
  assert.equal(replacements, 0);
  overlay.show(editor, { kind: 'translated', text: 'Hello' });
  await replace.fire('click');
  await retry.fire('click');
  root.querySelector('[aria-label="Close translation preview"]').fire('click');
  assert.equal(retries, 2);
  assert.equal(replacements, 1);
  assert.equal(closes, 1);
  assert.equal(overlay.host.isConnected, false);
  assert.equal(draft.nextSibling, null);
  overlay.setLanguagePair({ source: 'zh', target: 'ja' });
  overlay.show(editor, { kind: 'translated', text: 'こんにちは' });
  assert.equal(root.querySelector('[data-part="language"]').textContent, 'Japanese');
  assert.equal(root.querySelector('[data-part="result"]').lang, 'ja');
  overlay.destroy();
  assert.equal(overlay.host.isConnected, false);
});

test('AI privacy help opens on hover and focus without invoking AI, and dismisses on Escape', async t => {
  installDOM(t);
  const editor = document.createElement('div');
  document.body.append(editor);
  let calls = 0;
  const overlay = createOverlay(() => {}, () => {}, () => ({ container: document.body, before: null }), { source: 'zh', target: 'en' }, undefined, undefined, {
    improve() { calls += 1; }, select() {},
  });
  overlay.show(editor, { kind: 'translated', text: 'Hello', ai: { status: 'idle', selected: 'local' } });
  const root = overlay.host.shadowRoot;
  const tooltip = root.querySelector('div[role="tooltip"]');
  const button = root.querySelector('[aria-describedby="nt-ai-privacy-tooltip"]');
  assert.equal(tooltip.textContent, 'Improve with AI sends your original draft and local translation to Cloudflare for cloud processing, only when clicked.');
  assert.equal(tooltip.hidden, true);
  await button.parentElement.fire('mouseenter');
  assert.equal(tooltip.hidden, false);
  await button.parentElement.fire('mouseleave');
  assert.equal(tooltip.hidden, true);
  await button.fire('focus');
  assert.equal(tooltip.hidden, false);
  button.dispatchEvent({ type: 'keydown', key: 'Escape', stopPropagation() {} });
  assert.equal(tooltip.hidden, true);
  await button.fire('blur');
  await button.fire('focus');
  assert.equal(tooltip.hidden, false);
  assert.equal(calls, 0);
  await button.fire('click');
  assert.equal(calls, 1);
  overlay.hide();
  assert.equal(tooltip.hidden, true);
  overlay.destroy();
});

test('an unconfirmed entitlement stays hidden and a later update wins over a stale read', async t => {
  installDOM(t);
  let resolveLoad;
  const listeners = new Set();
  const overlay = createOverlay(() => {}, () => {}, () => ({ container: document.body, before: null }), { source: 'zh', target: 'en' }, undefined, undefined, undefined, {
    entitlement: {
      load: () => new Promise(resolve => { resolveLoad = resolve; }),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  const editor = document.createElement('div');
  document.body.append(editor);
  overlay.show(editor, { kind: 'translated', text: 'Hello' });
  const plan = overlay.host.shadowRoot.querySelector('[data-part="plan"]');
  assert.equal(plan.hidden, true);
  for (const listener of listeners) listener('plus');
  assert.equal(plan.hidden, false);
  assert.equal(plan.textContent, 'Plus');
  assert.equal(plan.getAttribute('data-plan'), 'plus');
  resolveLoad('free');
  await settle();
  assert.equal(plan.textContent, 'Plus');
  for (const listener of listeners) listener('free');
  assert.equal(plan.textContent, 'Free');
  assert.equal(plan.getAttribute('data-plan'), 'free');
  for (const listener of listeners) listener('unknown');
  assert.equal(plan.hidden, true);
  assert.equal(plan.textContent, '');
  overlay.destroy();
});

test('brand settings and dismiss stay independent beside a static target language', async t => {
  const { document } = installDOM(t);
  const { editor } = composer(document);
  let opens = 0;
  let closes = 0;
  const overlay = createOverlay(() => {}, () => {}, editor => xPlatform.previewLayout(editor),
    { source: 'zh', target: 'en' }, () => closes++, () => opens++);
  overlay.show(editor, { kind: 'translated', text: 'Hello' });
  const root = overlay.host.shadowRoot;
  const rule = root.querySelector('[data-part="rule"]');
  const brand = root.querySelector('[aria-label="Open NativeType settings"]');
  const language = root.querySelector('[data-part="language"]');
  const close = root.querySelector('[aria-label="Close translation preview"]');
  assert.equal(rule.contains(brand), true);
  assert.equal(language.parentElement, close.parentElement);
  assert.equal(language.parentElement.parentElement, rule);
  assert.equal(root.querySelector('select'), null);
  assert.equal(language.textContent, 'English');
  assert.equal(brand.contains(language), false);
  assert.equal(root.querySelector('header'), null);
  assert.equal(root.querySelector('span[role="tooltip"]').textContent, 'Open NativeType settings');
  await brand.fire('click');
  assert.equal(opens, 1);
  assert.equal(closes, 0);
  close.fire('click');
  assert.equal(closes, 1);
  assert.equal(editor.innerText, '原文');
});
