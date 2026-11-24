import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, settle } from '../dom-fixture.mjs';
import { loadTs } from '../load-ts.mjs';
import { attachedPost, chatComposer } from '../platforms/x-fixture.mjs';

// Existing usage regressions continue to assert the original counters.
function usageEvents(events) { return events.filter(event => ['translation_success', 'translation_error', 'replace_success'].includes(event)); }

function previewsIn(node, found = []) {
  if (!node?.querySelectorAll) return found;
  found.push(...node.querySelectorAll('[data-nativetype]'));
  for (const element of node.querySelectorAll('*')) {
    if (element.shadowRoot) previewsIn(element.shadowRoot, found);
  }
  return found;
}

const { startNativeType } = await loadTs('core/controller.ts');
const { xPlatform } = await loadTs('platforms/x.ts');
const { createMemoryBackend, createSettingsStore, getDefaultSettings } = await loadTs('settings/store.ts');
const { TranslationError } = await loadTs('translators/types.ts');
const { PolishError } = await loadTs('ai/client.ts');

async function setup(t, translate = async () => 'Translated draft', replace, options = {}) {
  const dom = installDOM(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { document } = dom;
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const postEditor = document.createElement('div');
  postEditor.contentEditable = 'true';
  postEditor.setAttribute('role', 'textbox');
  postEditor.dataset.testid = 'tweetTextarea_0';
  postEditor.innerText = options.text ?? '這是一段測試文字';
  const { attachment, card: quote } = attachedPost(document);
  dialog.append(postEditor, attachment);
  document.body.append(dialog);
  if (options.chat) location.pathname = '/i/chat/100-200';
  const chat = options.chat ? chatComposer(document, { text: options.text }) : undefined;
  const editor = chat?.editor ?? postEditor;
  editor.focus();
  const settings = getDefaultSettings();
  settings.contexts.x.post = false;
  Object.assign(settings.contexts.x, options.contexts);
  const pair = options.pair ?? { source: 'zh', target: 'en' };
  settings.translation = { mode: options.mode ?? 'automatic', sourceLanguage: pair.source, targetLanguage: pair.target };
  settings.analytics.enabled = options.analyticsEnabled ?? false;
  const analyticsEvents = [];
  const analyticsReports = [];
  let replacements = 0;
  let signal;
  const backend = createMemoryBackend(settings);
  const store = options.settings ?? createSettingsStore({
    ...backend,
    watch: options.missSettingsEvents ? () => () => {} : backend.watch,
  });
  const listeners = [];
  let invalidate;
  const retainedPairs = [];
  let disposals = 0;
  const platform = {
    ...xPlatform,
    ...(options.writingContext ? { writingContext: () => options.writingContext } : {}),
    async replaceText(...args) {
      replacements += 1;
      if (replace) return replace(...args);
      if (options.chat) return xPlatform.replaceText(...args);
      args[0].innerText = args[2];
      return true;
    },
  };
  startNativeType({
    platform,
    provider: {
      translate(text, request) { signal = request.signal; return translate(text, request); },
      prepare() {},
      retainPair: (source, target) => retainedPairs.push({ source, target }),
      dispose: () => { disposals += 1; },
    },
    languagePair: pair,
    detector: options.detector,
    analytics: options.analytics ?? ((event, context) => { analyticsEvents.push(event); analyticsReports.push({ event, ...context }); }),
    polish: options.polish,
    settings: store,
    host: {
      listen: (target, type, listener) => listeners.push({ target, type, listener }),
      onInvalidated(listener) { invalidate = listener; dom.onCleanup(listener); },
      openSettings: options.openSettings,
    },
  });
  await settle();
  t.mock.timers.tick(options.initialWait ?? 1000);
  await settle();
  dom.flushFrames();
  const overlay = previewsIn(document.body)[0];
  return {
    ...dom, editor, postEditor, chat, overlay, settings: store, retainedPairs, analyticsEvents, analyticsReports,
    disposals: () => disposals,
    invalidate: () => invalidate(),
    emit(type, target = document, eventTarget = document.activeElement, composedTarget = eventTarget, extra = {}) {
      for (const item of listeners) if (item.type === type && item.target === target) item.listener({ target: eventTarget, composedPath: () => [composedTarget], ...extra });
    },
    replacements: () => replacements,
    signal: () => signal,
    replace: () => overlay.shadowRoot.querySelectorAll('button').find(button => button.textContent === 'Replace').fire('click'),
    retry: () => overlay.shadowRoot.querySelectorAll('button').find(button => button.textContent === 'Retry').fire('click'),
    enable: () => overlay.shadowRoot.querySelectorAll('button').find(button => button.textContent === 'Enable translation').fire('click'),
    improve: () => overlay.shadowRoot.querySelectorAll('button').find(button => ['Improve with AI', 'Improving…', 'Retry AI'].includes(button.textContent)).fire('click'),
    selectPreview: label => overlay.shadowRoot.querySelectorAll('button').find(button => button.textContent === label).fire('click'),
    removeQuote(notify = true) {
      quote.remove();
      if (notify) dom.mutate([{ type: 'childList', target: attachment }]);
    },
  };
}

test('removing a quote without editing text hides the inline preview and leaves the input height alone', async t => {
  const fixture = await setup(t);
  assert.equal(fixture.overlay.style.display, 'block');
  assert.equal(fixture.editor.style.getPropertyValue('min-height'), '');
  assert.equal(fixture.overlay.parentElement, fixture.editor.parentElement);
  assert.equal(fixture.editor.nextSibling, fixture.overlay);
  fixture.removeQuote();
  assert.equal(fixture.overlay.style.display, 'none');
  assert.equal(fixture.overlay.isConnected, false);
  assert.equal(fixture.editor.style.getPropertyValue('min-height'), '');
  await fixture.replace();
  assert.equal(fixture.replacements(), 0);
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
});

test('analytics counts one completed translation across DOM refresh and cached preview reuse', async t => {
  let calls = 0;
  const fixture = await setup(t, async () => { calls += 1; return 'Translated draft'; }, undefined, { analyticsEnabled: true });
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_success']);
  fixture.emit('input', document, fixture.editor);
  fixture.mutate([{ type: 'childList', target: fixture.editor }]);
  fixture.flushFrames();
  const original = fixture.editor.innerText;
  fixture.editor.innerText = 'A different language';
  fixture.emit('input', document, fixture.editor);
  fixture.editor.innerText = original;
  fixture.emit('input', document, fixture.editor);
  await settle();
  fixture.flushFrames();
  assert.equal(fixture.overlay.style.display, 'block');
  assert.equal(calls, 1);
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_success']);
});

test('new input and explicit Retry are separate successful translation operations', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true });
  fixture.editor.innerText = '這是新的內容';
  fixture.emit('input', document, fixture.editor);
  t.mock.timers.tick(1000);
  await settle();
  await fixture.retry();
  await settle();
  assert.deepEqual(usageEvents(fixture.analyticsEvents), Array(3).fill('translation_success'));
});

test('Replace only reports after the verified operation succeeds and cannot double count', async t => {
  let complete;
  const fixture = await setup(t, undefined, (editor, _source, translation) => new Promise(resolve => {
    complete = () => { editor.innerText = translation; resolve(true); };
  }), { analyticsEnabled: true });
  const replacing = fixture.replace();
  await settle();
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_success']);
  complete();
  await replacing;
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'Translated draft');
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_success', 'replace_success']);
});

test('a failed Replace reports neither replacement success nor translation failure', async t => {
  const fixture = await setup(t, undefined, async () => false, { analyticsEnabled: true });
  await fixture.replace();
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_success']);
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
});

test('terminal translation failure counts once and Retry can then count success', async t => {
  let failing = true;
  const fixture = await setup(t, async () => {
    if (failing) throw new TranslationError('error', 'Translation failed. Please retry.');
    return 'Recovered translation';
  }, undefined, { analyticsEnabled: true });
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_error']);
  failing = false;
  await fixture.retry();
  await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Recovered translation');
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_error', 'translation_success']);
});

test('a model-unavailable translation attempt counts as a terminal error', async t => {
  const fixture = await setup(t, async () => { throw new TranslationError('unsupported', 'Model unavailable'); }, undefined, { analyticsEnabled: true });
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_error']);
});

test('waiting for model activation is not a translation error', async t => {
  const fixture = await setup(t, async () => { throw new TranslationError('enable', 'Enable translation'); }, undefined, { analyticsEnabled: true });
  assert.deepEqual(usageEvents(fixture.analyticsEvents), []);
});

test('an aborted execution never counts as a translation error', async t => {
  const fixture = await setup(t, async () => { throw new DOMException('Cancelled', 'AbortError'); }, undefined, { analyticsEnabled: true });
  assert.deepEqual(usageEvents(fixture.analyticsEvents), []);
});

test('closing Preview cancels a pending operation without reporting late success', async t => {
  let complete;
  const fixture = await setup(t, () => new Promise(resolve => { complete = resolve; }), undefined, { analyticsEnabled: true });
  const close = fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'Close translation preview');
  await close.fire('click');
  complete('Late translation');
  await settle();
  assert.deepEqual(usageEvents(fixture.analyticsEvents), []);
});

test('a newer request supersedes the old result and only counts its own success', async t => {
  const pending = [];
  const fixture = await setup(t, () => new Promise(resolve => { pending.push(resolve); }), undefined, { analyticsEnabled: true });
  fixture.editor.innerText = '這是較新的內容';
  fixture.emit('input', document, fixture.editor);
  t.mock.timers.tick(1000);
  await settle();
  pending[0]('Stale translation');
  await settle();
  assert.deepEqual(usageEvents(fixture.analyticsEvents), []);
  pending[1]('Current translation');
  await settle();
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_success']);
});

test('a normal editor removal suppresses a late execution error', async t => {
  let fail;
  const fixture = await setup(t, () => new Promise((_resolve, reject) => { fail = reject; }), undefined, { analyticsEnabled: true });
  fixture.editor.remove();
  fail(new Error('Late failure'));
  await settle();
  assert.deepEqual(usageEvents(fixture.analyticsEvents), []);
});

test('language detection failure before translation starts is not a translation event', async t => {
  let translated = false;
  const fixture = await setup(t, async () => { translated = true; return 'translation'; }, undefined, {
    analyticsEnabled: true, text: 'This is enough English text for detection', pair: { source: 'en', target: 'ja' },
    detector: { detect: async () => ({ status: 'error', message: 'Detection failed' }), dispose() {}, reset() {} },
  });
  assert.equal(translated, false);
  assert.deepEqual(usageEvents(fixture.analyticsEvents), []);
});

test('a synchronous analytics failure preserves Preview and Replace without error recursion', async t => {
  const events = [];
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true, analytics: event => {
    events.push(event);
    throw new Error('Analytics failed');
  } });
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'Translated draft');
  assert.deepEqual(usageEvents(events), ['translation_success', 'replace_success']);
});

test('rejected analytics promises preserve local success without extra translation errors', async t => {
  const events = [];
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true, analytics: async event => {
    events.push(event);
    throw new Error('Network unavailable');
  } });
  await fixture.replace();
  await settle();
  assert.equal(fixture.editor.innerText, 'Translated draft');
  assert.deepEqual(usageEvents(events), ['translation_success', 'replace_success']);
});

test('a hung analytics promise never delays Preview or Replace', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true, analytics: () => new Promise(() => {}) });
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'Translated draft');
});

test('already-open X tabs follow opt-in changes without retransmitting an old Preview', async t => {
  const fixture = await setup(t);
  assert.deepEqual(usageEvents(fixture.analyticsEvents), []);
  const next = await fixture.settings.load();
  next.analytics.enabled = true;
  await fixture.settings.save(next);
  assert.deepEqual(usageEvents(fixture.analyticsEvents), []);
  await fixture.retry();
  await settle();
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_success']);
  next.analytics.enabled = false;
  await fixture.settings.save(next);
  await fixture.replace();
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_success']);
  assert.equal(fixture.editor.innerText, 'Translated draft');
});

test('Replace rechecks the context before the observer has delivered a DOM change', async t => {
  const fixture = await setup(t);
  fixture.removeQuote(false);
  await fixture.replace();
  assert.equal(fixture.replacements(), 0);
  assert.equal(fixture.overlay.style.display, 'none');
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
});

test('a context change cancels an in-flight request and cannot restore its preview', async t => {
  let finishTranslation;
  const fixture = await setup(t, () => new Promise(resolve => { finishTranslation = resolve; }));
  fixture.removeQuote();
  assert.equal(fixture.signal().aborted, true);
  finishTranslation('Stale result');
  await settle();
  fixture.flushFrames();
  assert.equal(fixture.overlay.style.display, 'none');
  assert.notEqual(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Stale result');
});

test('late translation results recheck context even before a DOM notification', async t => {
  let finishTranslation;
  const fixture = await setup(t, () => new Promise(resolve => { finishTranslation = resolve; }));
  fixture.removeQuote(false);
  finishTranslation('Stale result');
  await settle();
  fixture.flushFrames();
  assert.equal(fixture.overlay.style.display, 'none');
  assert.notEqual(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Stale result');
});

test('a context change during asynchronous replacement invalidates the final write', async t => {
  let finishReplacement;
  const fixture = await setup(t, undefined, async (editor, _source, translation, canReplace) => {
    await new Promise(resolve => { finishReplacement = resolve; });
    if (!canReplace()) return false;
    editor.innerText = translation;
    return true;
  });
  const replacing = fixture.replace();
  fixture.removeQuote();
  finishReplacement();
  await replacing;
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
  assert.equal(fixture.overlay.style.display, 'none');
});

test('unrelated composer mutations do not restart pending language detection', async t => {
  let finishDetection;
  let detectionSignal;
  let detections = 0;
  const fixture = await setup(t, undefined, undefined, {
    text: 'Hello world',
    pair: { source: 'en', target: 'zh' },
    detector: {
      detect(_text, _source, request) {
        detections += 1;
        detectionSignal = request.signal;
        return new Promise(resolve => { finishDetection = resolve; });
      },
      prepare() {}, reset() {}, dispose() {},
    },
  });
  fixture.mutate([{ type: 'childList', target: fixture.editor.parentElement }]);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(detections, 1);
  assert.equal(detectionSignal.aborted, false);
  finishDetection({ status: 'match' });
  await settle();
  fixture.flushFrames();
  const overlay = previewsIn(fixture.document.body)[0];
  assert.equal(overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
});

test('the Quote switch controls the live attached-post structure independently of New posts', async t => {
  let translations = 0;
  const fixture = await setup(t, async () => { translations += 1; return 'A quote translation'; });
  assert.equal(fixture.overlay.style.display, 'block');
  const next = await fixture.settings.load();
  next.contexts.x = { post: true, reply: false, quote: false };
  await fixture.settings.save(next);
  assert.equal(fixture.overlay.style.display, 'none');
  await fixture.replace();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(translations, 1);
  assert.equal(fixture.replacements(), 0);
  next.contexts.x = { post: false, reply: false, quote: true };
  await fixture.settings.save(next);
  fixture.flushFrames();
  assert.equal(fixture.overlay.style.display, 'block');
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'A quote translation');
});

test('returning to X resyncs a missed language update before allowing the old preview to replace', async t => {
  const requests = [];
  let resets = 0;
  const fixture = await setup(t, async (_text, request) => {
    requests.push({ source: request.source, target: request.target });
    return `${request.source} to ${request.target}`;
  }, undefined, {
    missSettingsEvents: true,
    detector: {
      detect: async () => ({ status: 'match' }),
      prepare() {}, reset: () => { resets += 1; }, dispose() {},
    },
  });
  const next = await fixture.settings.load();
  next.translation = { mode: 'automatic', sourceLanguage: 'zh-Hant', targetLanguage: 'ja' };
  await fixture.settings.save(next);
  fixture.emit('focus', window);
  assert.equal(fixture.overlay.style.display, 'none');
  await fixture.replace();
  assert.equal(fixture.replacements(), 0);
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  fixture.flushFrames();
  assert.deepEqual(requests, [{ source: 'zh', target: 'en' }, { source: 'zh-Hant', target: 'ja' }]);
  assert.equal(resets, 1);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'zh-Hant to ja');
});

test('visibility and pageshow recover missed context changes without reloading the page', async t => {
  const fixture = await setup(t, undefined, undefined, { missSettingsEvents: true });
  const next = await fixture.settings.load();
  next.contexts.x = { post: true, reply: true, quote: false };
  await fixture.settings.save(next);
  fixture.document.visibilityState = 'hidden';
  fixture.emit('visibilitychange');
  assert.equal(fixture.overlay.style.display, 'block');
  fixture.document.visibilityState = 'visible';
  fixture.emit('visibilitychange');
  assert.equal(fixture.overlay.style.display, 'none');
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(fixture.overlay.style.display, 'none');
  next.contexts.x.quote = true;
  await fixture.settings.save(next);
  fixture.emit('pageshow', window);
  await settle();
  fixture.flushFrames();
  assert.equal(fixture.overlay.style.display, 'block');
});

test('focusing a composer resyncs settings when its context was previously disabled', async t => {
  const fixture = await setup(t, undefined, undefined, {
    missSettingsEvents: true,
    contexts: { quote: false },
  });
  assert.equal(previewsIn(fixture.document.body).length, 0);
  const next = await fixture.settings.load();
  next.contexts.x.quote = true;
  await fixture.settings.save(next);
  fixture.emit('focusin');
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  fixture.flushFrames();
  assert.equal(previewsIn(fixture.document.body)[0].style.display, 'block');
});

function delayedSettings() {
  const initial = getDefaultSettings();
  initial.translation.mode = 'automatic';
  initial.contexts.x.post = false;
  const pending = [];
  let reads = 0;
  let notify;
  return {
    initial, pending, reads: () => reads,
    notify: settings => notify(settings),
    store: {
      load() {
        reads += 1;
        return reads === 1 ? Promise.resolve(initial) : new Promise(resolve => pending.push(resolve));
      },
      subscribe(listener) { notify = listener; return () => { notify = () => {}; }; },
    },
  };
}

test('a newer resume during a slow read is re-read before any stale pair is applied', async t => {
  const settings = delayedSettings();
  const requests = [];
  const fixture = await setup(t, async (_text, request) => {
    requests.push(request.target);
    return request.target;
  }, undefined, { settings: settings.store });
  fixture.emit('focus', window);
  fixture.emit('pageshow', window);
  settings.pending[0]({ ...settings.initial, translation: { mode: 'automatic', sourceLanguage: 'zh', targetLanguage: 'ja' } });
  await settle();
  assert.equal(settings.pending.length, 2);
  assert.deepEqual(fixture.retainedPairs, []);
  assert.equal(fixture.overlay.style.display, 'none');
  settings.pending[1]({ ...settings.initial, translation: { mode: 'automatic', sourceLanguage: 'zh', targetLanguage: 'ko' } });
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(requests, ['en', 'ko']);
  assert.deepEqual(fixture.retainedPairs, [{ source: 'zh', target: 'ko' }]);
});

test('a storage notification wins over an older asynchronous settings read', async t => {
  const settings = delayedSettings();
  const fixture = await setup(t, async (_text, request) => request.target, undefined, { settings: settings.store });
  fixture.emit('focus', window);
  settings.notify({ ...settings.initial, translation: { mode: 'automatic', sourceLanguage: 'zh', targetLanguage: 'fr' } });
  settings.pending[0]({ ...settings.initial, translation: { mode: 'automatic', sourceLanguage: 'zh', targetLanguage: 'ja' } });
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  fixture.flushFrames();
  assert.deepEqual(fixture.retainedPairs, [{ source: 'zh', target: 'fr' }]);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'fr');
});

test('invalidation prevents a late settings read from restarting the disposed controller', async t => {
  const settings = delayedSettings();
  const fixture = await setup(t, undefined, undefined, { settings: settings.store });
  fixture.emit('focus', window);
  fixture.invalidate();
  settings.pending[0]({ ...settings.initial, translation: { mode: 'automatic', sourceLanguage: 'zh', targetLanguage: 'ja' } });
  await settle();
  fixture.emit('pageshow', window);
  assert.equal(settings.reads(), 2);
  assert.equal(fixture.disposals(), 1);
  assert.deepEqual(fixture.retainedPairs, []);
  assert.equal(fixture.overlay.isConnected, false);
});

test('a failed resume read retains the last successful settings and translation', async t => {
  const settings = delayedSettings();
  const store = { ...settings.store, load: () => settings.reads() === 0 ? settings.store.load() : Promise.reject(new Error('Storage unavailable')) };
  const fixture = await setup(t, undefined, undefined, { settings: store });
  fixture.emit('focus', window);
  await settle();
  fixture.flushFrames();
  assert.equal(fixture.overlay.style.display, 'block');
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
  assert.deepEqual(fixture.retainedPairs, []);
});

test('resuming the page invalidates a paste already waiting for X selection', async t => {
  let finishReplacement;
  const fixture = await setup(t, undefined, async (editor, _source, translation, canReplace) => {
    await new Promise(resolve => { finishReplacement = resolve; });
    if (!canReplace()) return false;
    editor.innerText = translation;
    return true;
  });
  const replacing = fixture.replace();
  fixture.emit('focus', window);
  await settle();
  finishReplacement();
  await replacing;
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
});

test('IME composition started during a settings read waits for the committed input', async t => {
  const settings = delayedSettings();
  const requests = [];
  const fixture = await setup(t, async text => { requests.push(text); return 'Translation'; }, undefined, { settings: settings.store });
  fixture.emit('focus', window);
  fixture.emit('compositionstart');
  fixture.editor.innerText = '這是輸入法尚未提交的文字';
  fixture.emit('input');
  settings.pending[0](settings.initial);
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(requests, ['這是一段測試文字']);
  fixture.emit('compositionend');
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(requests, ['這是一段測試文字', '這是輸入法尚未提交的文字']);
});

test('the preview settings button opens settings without changing the draft and survives language updates', async t => {
  let opens = 0;
  const fixture = await setup(t, undefined, undefined, { openSettings: () => { opens += 1; } });
  const settingsButton = fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'Open NativeType settings');
  await settingsButton.fire('click');
  assert.equal(opens, 1);
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
  assert.equal(fixture.overlay.style.display, 'block');
  const next = await fixture.settings.load();
  next.translation.targetLanguage = 'ja';
  await fixture.settings.save(next);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('[data-part="name"]').textContent, 'NativeType');
  assert.equal(fixture.overlay.shadowRoot.querySelector('[data-part="language"]').textContent, 'Japanese');
  assert.equal(settingsButton.isConnected, true);
  await settingsButton.fire('click');
  assert.equal(opens, 2);
  assert.equal(fixture.replacements(), 0);
});

test('a settings-open failure preserves the translation and allows replacement', async t => {
  const fixture = await setup(t, undefined, undefined, { openSettings: async () => { throw new Error('Extension context invalidated'); } });
  const settingsButton = fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'Open NativeType settings');
  await settingsButton.fire('click');
  assert.equal(settingsButton.disabled, false);
  assert.match(fixture.overlay.shadowRoot.querySelector('span[role="tooltip"]').textContent, /Couldn’t open settings/);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'Translated draft');
});

test('returning from settings with keyboard focus in the preview resumes the same composer', async t => {
  const requests = [];
  let fixture;
  fixture = await setup(t, async (_text, request) => { requests.push(request.target); return request.target; }, undefined, {
    missSettingsEvents: true,
    openSettings: () => {
      fixture.overlay.focus();
      fixture.emit('focusin');
    },
  });
  const settingsButton = fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'Open NativeType settings');
  await settingsButton.fire('click');
  const next = await fixture.settings.load();
  next.translation.targetLanguage = 'ja';
  await fixture.settings.save(next);
  fixture.emit('focus', window);
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  fixture.flushFrames();
  assert.deepEqual(requests, ['en', 'ja']);
  assert.equal(fixture.overlay.style.display, 'block');
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
});

test('Chat preview focus survives nested shadow retargeting and settings resume', async t => {
  const fixture = await setup(t, undefined, undefined, { chat: true });
  const button = fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.textContent === 'Replace');
  // Model the browser's nested activeElement chain (the DOM fixture's focus()
  // only retargets one shadow boundary). The browser fixture covers real focus.
  document.activeElement = fixture.chat.host;
  fixture.chat.root.activeElement = fixture.overlay;
  fixture.overlay.shadowRoot.activeElement = button;
  fixture.emit('focusout', document, fixture.chat.host, fixture.editor);
  fixture.emit('focusin', document, fixture.chat.host, button);
  t.mock.timers.tick(0);
  assert.equal(fixture.overlay.isConnected, true);
  assert.equal(fixture.overlay.style.display, 'block');

  fixture.emit('focus', window);
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(fixture.chat.root.activeElement, fixture.editor);
  assert.equal(fixture.overlay.isConnected, true);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');

  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  fixture.emit('focusin', document, outside);
  assert.equal(fixture.overlay.isConnected, false);
});

test('Chat uses the existing debounce, preview and guarded replacement through a shadow host', async t => {
  const requests = [];
  const fixture = await setup(t, async text => { requests.push(text); return 'Translated chat'; }, undefined, { chat: true, analyticsEnabled: true });
  assert.deepEqual(requests, ['这是一段聊天草稿']);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated chat');
  assert.equal(fixture.editor.style.getPropertyValue('min-height'), '');
  assert.equal(fixture.chat.inputContainer.style.getPropertyValue('min-height'), '');
  let state = fixture.editor.value;
  fixture.editor.addEventListener('input', () => { state = fixture.editor.value; });
  const replacing = fixture.replace();
  t.mock.timers.tick(0);
  await settle();
  fixture.flushFrames();
  await replacing;
  assert.equal(state, 'Translated chat');
  assert.equal(fixture.overlay.style.display, 'none');
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_success', 'replace_success']);
  fixture.editor.value += '!';
  fixture.emit('input', document, fixture.chat.host, fixture.editor);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(fixture.editor.value, 'Translated chat!');
  assert.equal(requests.length, 1, 'the translated English draft is skipped by the existing Chinese trigger');
});

test('Chat rapid input aborts old work and never replaces a newer draft', async t => {
  const pending = [];
  const fixture = await setup(t, (text, request) => new Promise(resolve => pending.push({ text, request, resolve })), undefined, { chat: true });
  fixture.editor.value = '新的消息内容';
  fixture.emit('input', document, fixture.chat.host, fixture.editor);
  t.mock.timers.tick(400);
  fixture.editor.value += '继续输入';
  fixture.emit('input', document, fixture.chat.host, fixture.editor);
  t.mock.timers.tick(600);
  await settle();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request.signal.aborted, true);
  t.mock.timers.tick(400);
  await settle();
  pending[0].resolve('Stale result');
  pending[1].resolve('Current result');
  await settle();
  fixture.flushFrames();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Current result');
  fixture.editor.value = '用户在预览之后继续输入';
  await fixture.replace();
  assert.equal(fixture.replacements(), 0);
  assert.equal(fixture.editor.value, '用户在预览之后继续输入');
});

for (const notify of [false, true]) {
  test(`Chat switching a reused editor with identical text rejects old results (${notify ? 'with' : 'before'} route notification)`, async t => {
    const pending = [];
    const fixture = await setup(t, (text, request) => new Promise(resolve => pending.push({ request, resolve })), undefined, { chat: true });
    location.pathname = '/i/chat/100-300';
    if (notify) window.navigation.dispatchEvent({ type: 'currententrychange' });
    pending[0].resolve('Conversation A result');
    await settle();
    fixture.flushFrames();
    assert.equal(pending[0].request.signal.aborted, true);
    assert.equal(fixture.overlay.style.display, 'none');
    assert.notEqual(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Conversation A result');
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(pending.length, 2);
    pending[1].resolve('Conversation B result');
    await settle();
    fixture.flushFrames();
    assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Conversation B result');
    assert.equal(fixture.observerCount(), 1);
  });
}

test('a Chat switch immediately hides an existing preview and never reuses another conversation cache', async t => {
  let translations = 0;
  const fixture = await setup(t, async () => `Translation ${++translations}`, undefined, { chat: true });
  const listeners = fixture.routeListenerCount();
  for (const id of [300, 400, 500]) {
    location.pathname = `/i/chat/100-${id}`;
    window.navigation.dispatchEvent({ type: 'currententrychange' });
    assert.equal(fixture.overlay.style.display, 'none');
    assert.equal(fixture.observerCount(), 1);
    assert.equal(fixture.routeListenerCount(), listeners);
    t.mock.timers.tick(1000);
    await settle();
    fixture.flushFrames();
  }
  assert.equal(translations, 4);
  assert.equal(previewsIn(document.body).length, 1);
});

test('Chat switches during Replace invalidate the queued native setter', async t => {
  const fixture = await setup(t, undefined, undefined, { chat: true });
  const replacing = fixture.replace();
  location.pathname = '/i/chat/100-300';
  window.navigation.dispatchEvent({ type: 'currententrychange' });
  t.mock.timers.tick(0);
  await settle();
  fixture.flushFrames();
  await replacing;
  assert.equal(fixture.editor.value, '这是一段聊天草稿');
  assert.equal(fixture.overlay.style.display, 'none');
});

test('Chat can be disabled during translation while Post, Reply and Quote keep their settings', async t => {
  let complete;
  let calls = 0;
  const fixture = await setup(t, () => {
    calls += 1;
    return calls === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve('Post translation');
  }, undefined, { chat: true, contexts: { post: true } });
  const next = await fixture.settings.load();
  next.contexts.x.chat = false;
  await fixture.settings.save(next);
  assert.equal(fixture.signal().aborted, true);
  assert.equal(fixture.observerCount(), 0);
  complete('Disabled Chat result');
  await settle();
  fixture.flushFrames();
  assert.equal(fixture.overlay.style.display, 'none');
  fixture.editor.value = '关闭聊天翻译后的输入';
  fixture.emit('input', document, fixture.chat.host, fixture.editor);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual((await fixture.settings.load()).contexts.x, { post: true, reply: true, quote: true, chat: false });
  fixture.removeQuote(false);
  location.pathname = '/home';
  fixture.postEditor.focus();
  fixture.emit('focusin');
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  fixture.flushFrames();
  assert.equal(xPlatform.writingContext(fixture.postEditor), 'post');
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Post translation');
});

test('unmounting the Chat shadow host cleans the preview and listeners, and a remounted editor can translate', async t => {
  const fixture = await setup(t, undefined, undefined, { chat: true });
  fixture.chat.host.remove();
  fixture.mutate([{ type: 'childList', target: document.body }]);
  assert.equal(fixture.overlay.style.display, 'none');
  assert.equal(fixture.observerCount(), 0);
  assert.equal(fixture.resizeTargetCount(), 0, 'the inline preview does not keep a resize watcher');
  const chat = chatComposer(document, { text: '重新挂载后的草稿' });
  chat.editor.focus();
  fixture.emit('focusin', document, chat.host, chat.editor);
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  fixture.flushFrames();
  assert.equal(fixture.overlay.style.display, 'block');
  assert.equal(fixture.observerCount(), 1);
  fixture.invalidate();
  assert.equal(fixture.routeListenerCount(), 0);
  assert.equal(fixture.observerCount(), 0);
  assert.equal(fixture.resizeTargetCount(), 0);
  assert.equal(fixture.overlay.isConnected, false);
});

test('Chat IME composition works through composed events without translating unfinished text', async t => {
  const requests = [];
  const fixture = await setup(t, async text => { requests.push(text); return 'Translation'; }, undefined, { chat: true });
  fixture.emit('compositionstart', document, fixture.chat.host, fixture.editor);
  fixture.editor.value = '输入法尚未提交的内容';
  fixture.emit('input', document, fixture.chat.host, fixture.editor);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(requests.length, 1);
  fixture.emit('compositionend', document, fixture.chat.host, fixture.editor);
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(requests, ['这是一段聊天草稿', '输入法尚未提交的内容']);
});

const improved = (text = 'AI improved draft') => ({ success: true, text, model: '@cf/google/gemma-4-26b-a4b-it', elapsed_ms: 10,
  request_id: 'fixture', finish_reason: 'stop', usage: { prompt_tokens: 20, completion_tokens: 5, neurons: 0.1 } });

test('AI is manual, keeps Local and AI previews, and Replace uses the selected version', async t => {
  const calls = [];
  const fixture = await setup(t, undefined, undefined, { polish: async input => { calls.push(input); return improved(); } });
  assert.equal(calls.length, 0);
  assert.match(fixture.overlay.textContent + fixture.overlay.shadowRoot.textContent, /cloud processing/);
  await fixture.improve();
  await settle();
  assert.deepEqual(calls, [{ source_language: 'zh', target_language: 'en', original_source: '這是一段測試文字', draft: 'Translated draft', writing_context: 'quote' }]);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'AI improved draft');
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
  await fixture.selectPreview('Local');
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
  await fixture.selectPreview('AI Improved');
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'AI improved draft');
  assert.equal(fixture.replacements(), 1);
});

test('Local can still be replaced after AI succeeds', async t => {
  const fixture = await setup(t, undefined, undefined, { polish: async () => improved() });
  await fixture.improve(); await settle();
  await fixture.selectPreview('Local'); await fixture.replace();
  assert.equal(fixture.editor.innerText, 'Translated draft');
});

test('Retry stays local until AI is attempted, then stays AI even after selecting Local', async t => {
  let localCalls = 0;
  const requests = [];
  const fixture = await setup(t, async () => { localCalls++; return 'Local draft'; }, undefined, {
    polish: async input => { requests.push(input); return improved(); },
  });
  await fixture.retry(); await settle();
  assert.equal(localCalls, 2);
  assert.equal(requests.length, 0);
  await fixture.improve(); await settle();
  await fixture.retry(); await settle();
  await fixture.selectPreview('Local');
  await fixture.retry(); await settle();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  assert.equal(localCalls, 2);
  assert.equal(fixture.replacements(), 0);
  fixture.editor.innerText = '這是另一個新的任務';
  fixture.emit('input', document, fixture.editor);
  t.mock.timers.tick(1000); await settle();
  await fixture.retry(); await settle();
  assert.equal(localCalls, 4);
  assert.equal(requests.length, 3);
});

test('ordinary Retry retries the failed AI request with the original local draft', async t => {
  let localCalls = 0;
  const requests = [];
  const fixture = await setup(t, async () => { localCalls++; return 'Local draft'; }, undefined, {
    polish: async input => {
      requests.push(input);
      if (requests.length === 1) throw new PolishError('MODEL_ERROR');
      return improved();
    },
  });
  await fixture.improve(); await settle();
  await fixture.retry(); await settle();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(localCalls, 1);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'AI improved draft');
});

for (const [writingContext, limit] of [['reply', 280], ['quote', 280], ['post', 4000], ['chat', 4000]]) {
  for (const length of [limit, limit + 1]) {
    test(`${writingContext} checks the local draft at ${length} characters, independently of original length`, async t => {
      const requests = [];
      const fixture = await setup(t, async () => 'a'.repeat(length), undefined, {
        writingContext, contexts: { post: true }, text: '原'.repeat(4500),
        polish: async input => { requests.push(input); return improved(); },
      });
      await fixture.improve(); await settle();
      assert.equal(requests.length, length === limit ? 1 : 0);
      assert.equal(fixture.editor.innerText, '原'.repeat(4500));
      if (length === limit) {
        assert.equal(requests[0].writing_context, writingContext);
        assert.equal(requests[0].original_source.length, 4500);
      } else {
        assert.match(fixture.overlay.shadowRoot.textContent, new RegExp(`${length}/${limit}`));
        assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'a'.repeat(length));
        await fixture.retry(); await settle();
        assert.equal(requests.length, 0);
      }
    });
  }
}

for (const code of ['UNAUTHORIZED', 'PLUS_REQUIRED']) {
  test(`${code} offers pricing and settings in a dismissible mask without losing Local`, async t => {
    let opened = 0;
    let calls = 0;
    const fixture = await setup(t, undefined, undefined, {
      openSettings: () => { opened++; },
      polish: async () => { calls++; throw new PolishError(code); },
    });
    await fixture.improve(); await settle();
    const root = fixture.overlay.shadowRoot;
    const mask = root.querySelector('[aria-label="Activate NativeType Plus"]');
    assert.equal(mask.hidden, false);
    const pricing = mask.querySelector('a');
    assert.equal(pricing.href, 'https://typewith.si/pricing');
    assert.equal(pricing.target, '_blank');
    await root.querySelectorAll('button').find(button => button.textContent === 'Open settings').fire('click');
    assert.equal(opened, 1);
    await root.querySelectorAll('button').find(button => button.textContent === 'Use Local').fire('click');
    assert.equal(mask.hidden, true);
    assert.equal(root.querySelector('p').textContent, 'Translated draft');
    assert.equal(calls, 1);
    await fixture.retry(); await settle();
    assert.equal(calls, 2);
    assert.equal(mask.hidden, false);
    mask.dispatchEvent({ type: 'keydown', key: 'Escape', stopPropagation() {} });
    assert.equal(mask.hidden, true);
    await fixture.replace();
    assert.equal(fixture.editor.innerText, 'Translated draft');
    assert.equal(calls, 2);
  });
}

test('AI loading blocks duplicate requests and Local Replace aborts pending AI', async t => {
  let calls = 0;
  let complete;
  let signal;
  const fixture = await setup(t, undefined, undefined, { polish: (_input, nextSignal) => {
    calls += 1; signal = nextSignal; return new Promise(resolve => { complete = resolve; });
  } });
  await fixture.improve(); await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.textContent === 'Improving…').disabled, true);
  await fixture.improve();
  await fixture.retry();
  assert.equal(calls, 1);
  await fixture.replace();
  assert.equal(signal.aborted, true);
  complete(improved()); await settle();
  assert.equal(fixture.editor.innerText, 'Translated draft');
  assert.equal(fixture.overlay.style.display, 'none');
});

test('AI failure preserves Local, restores the button, and allows an explicit retry', async t => {
  let calls = 0;
  const fixture = await setup(t, undefined, undefined, { polish: async () => {
    if (++calls === 1) throw new Error('Do not expose provider debug text');
    return improved();
  } });
  await fixture.improve(); await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
  assert.match(fixture.overlay.shadowRoot.textContent, /AI Improve failed/);
  assert.doesNotMatch(fixture.overlay.shadowRoot.textContent, /provider debug/);
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
  await fixture.improve(); await settle();
  assert.equal(calls, 2);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'AI improved draft');
});

test('source edits immediately invalidate AI and ignore a response even when cancellation is ignored', async t => {
  const pending = [];
  const fixture = await setup(t, undefined, undefined, { polish: (input, signal) => new Promise(resolve => { pending.push({ input, signal, resolve }); }) });
  await fixture.improve();
  fixture.editor.innerText = '更新後的文字'; fixture.emit('input');
  assert.equal(pending[0].signal.aborted, true);
  assert.notEqual(fixture.overlay.shadowRoot.querySelector('p').textContent, 'AI improved draft');
  t.mock.timers.tick(1000); await settle();
  await fixture.improve();
  pending[1].resolve(improved('New AI')); await settle();
  pending[0].resolve(improved('Old AI')); await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'New AI');
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'New AI');
});

test('language changes cancel AI and a late response cannot populate the new pair', async t => {
  let finish;
  let signal;
  const fixture = await setup(t, undefined, undefined, { polish: (_input, value) => { signal = value; return new Promise(resolve => { finish = resolve; }); } });
  await fixture.improve();
  const next = await fixture.settings.load(); next.translation.targetLanguage = 'ja'; await fixture.settings.save(next);
  assert.equal(signal.aborted, true);
  t.mock.timers.tick(1000); await settle();
  finish(improved('Old English')); await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
  assert.equal(fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.textContent === 'AI Improved').parentElement.hidden, true);
});

test('switching composers cannot carry over pending or completed AI', async t => {
  let finish;
  let signal;
  const fixture = await setup(t, undefined, undefined, { contexts: { post: true }, polish: (_input, value) => { signal = value; return new Promise(resolve => { finish = resolve; }); } });
  await fixture.improve();
  const second = fixture.document.createElement('div'); second.contentEditable = 'true'; second.setAttribute('role', 'textbox');
  second.dataset.testid = 'tweetTextarea_0'; second.innerText = '這是一段測試文字'; fixture.document.body.append(second); second.focus(); fixture.emit('focusin');
  await settle(); t.mock.timers.tick(1000); await settle();
  assert.equal(signal.aborted, true);
  finish(improved('From other composer')); await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
  await fixture.replace();
  assert.equal(second.innerText, 'Translated draft');
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
});

test('AI Replace rechecks the actual source before a pending DOM notification', async t => {
  const fixture = await setup(t, undefined, undefined, { polish: async () => improved() });
  await fixture.improve(); await settle();
  fixture.editor.innerText = '未通知的修改';
  await fixture.replace();
  assert.equal(fixture.replacements(), 0);
  assert.equal(fixture.editor.innerText, '未通知的修改');
});

test('reused Chat editor cannot apply AI to a different conversation with identical text', async t => {
  const fixture = await setup(t, undefined, undefined, { chat: true, polish: async () => improved() });
  const original = fixture.editor.value;
  await fixture.improve(); await settle();
  location.pathname = '/i/chat/300-400';
  await fixture.replace();
  assert.equal(fixture.replacements(), 0);
  assert.equal(fixture.editor.value, original);
});

test('closing or invalidating the extension aborts pending AI and suppresses late results', async t => {
  const pending = [];
  const fixture = await setup(t, undefined, undefined, { polish: (_input, signal) => new Promise(resolve => { pending.push({ signal, resolve }); }) });
  await fixture.improve();
  await fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.title === 'Close').fire('click');
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(improved()); await settle();
  assert.equal(fixture.overlay.style.display, 'none');
  fixture.editor.innerText = '另一次文字'; fixture.emit('input'); t.mock.timers.tick(1000); await settle();
  await fixture.improve(); fixture.invalidate();
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve(improved()); await settle();
  assert.equal(fixture.overlay.isConnected, false);
});

test('AI replacement reuses opt-in analytics without reporting drafts, and Local selection is not an AI replacement', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true, polish: async () => improved() });
  await fixture.improve(); await settle(); await fixture.replace();
  assert.deepEqual(usageEvents(fixture.analyticsEvents), ['translation_success', 'replace_success']);
  fixture.editor.innerText = '再一次輸入的文字'; fixture.emit('input'); t.mock.timers.tick(1000); await settle();
  await fixture.improve(); await settle(); await fixture.selectPreview('Local'); await fixture.replace();
  assert.deepEqual(usageEvents(fixture.analyticsEvents).slice(-2), ['translation_success', 'replace_success']);
  const next = await fixture.settings.load(); next.analytics.enabled = false; await fixture.settings.save(next);
  const count = fixture.analyticsEvents.length;
  fixture.editor.innerText = '關閉統計以後的文字'; fixture.emit('input'); t.mock.timers.tick(1000); await settle();
  await fixture.improve(); await settle(); await fixture.replace();
  assert.equal(fixture.analyticsEvents.length, count);
});

test('Manual never translates on input, but the existing activation, Retry and Replace work', async t => {
  const requests = [];
  const fixture = await setup(t, async (text, request) => { requests.push({ text, activated: request.activated }); return 'Manual translation'; }, undefined, { mode: 'manual' });
  fixture.editor.innerText = '手动翻译新内容';
  fixture.emit('input');
  t.mock.timers.tick(5000); await settle();
  assert.deepEqual(requests, []);
  assert.equal(fixture.replacements(), 0);
  await fixture.enable(); await settle();
  assert.deepEqual(requests, [{ text: '手动翻译新内容', activated: true }]);
  await fixture.retry(); await settle();
  assert.equal(requests.length, 2);
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'Manual translation');
});

test('Automatic waits exactly 900ms after the last effective input, ignoring duplicate events and mutations', async t => {
  const requests = [];
  const fixture = await setup(t, async text => { requests.push(text); return 'Latest result'; });
  fixture.editor.innerText = '新的输入'; fixture.emit('input');
  t.mock.timers.tick(450);
  fixture.editor.innerText += '继续'; fixture.emit('input');
  t.mock.timers.tick(450);
  fixture.emit('input'); fixture.mutate([{ type: 'childList', target: fixture.editor }]);
  t.mock.timers.tick(449); await settle();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(requests, ['這是一段測試文字', '新的输入继续']);
  assert.equal(fixture.editor.innerText, '新的输入继续');
  assert.equal(fixture.replacements(), 0);
});

test('Manual to Automatic checks the existing draft without requiring another input', async t => {
  let calls = 0;
  const fixture = await setup(t, async () => { calls++; return 'Translation'; }, undefined, { mode: 'manual' });
  const next = await fixture.settings.load(); next.translation.mode = 'automatic';
  await fixture.settings.save(next);
  t.mock.timers.tick(899); await settle(); assert.equal(calls, 0);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 1);
  assert.equal(fixture.observerCount(), 1);
});

test('Automatic to Manual clears waiting work and preserves a completed current result', async t => {
  let calls = 0;
  const fixture = await setup(t, async () => { calls++; return 'Translation'; });
  const next = await fixture.settings.load(); next.translation.mode = 'manual';
  await fixture.settings.save(next);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translation');
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'Translation');
  next.translation.mode = 'automatic'; await fixture.settings.save(next);
  fixture.editor.innerText = '等待中的输入'; fixture.emit('input');
  t.mock.timers.tick(899);
  next.translation.mode = 'manual'; await fixture.settings.save(next);
  t.mock.timers.tick(5000); await settle();
  assert.equal(calls, 1);
});

test('switching to Manual aborts in-flight automatic work and rejects late results; Retry stays manual', async t => {
  const pending = [];
  const fixture = await setup(t, (text, request) => new Promise(resolve => pending.push({ text, request, resolve })));
  const next = await fixture.settings.load(); next.translation.mode = 'manual';
  await fixture.settings.save(next);
  assert.equal(pending[0].request.signal.aborted, true);
  pending[0].resolve('Stale automatic'); await settle();
  assert.notEqual(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Stale automatic');
  await fixture.enable();
  assert.equal(pending[1].request.activated, true);
  pending[1].resolve('Manual result'); await settle();
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'Manual result');
});

test('mode changes during a user-initiated AI operation do not abort or invoke AI', async t => {
  let resolve;
  let calls = 0;
  let signal;
  const fixture = await setup(t, undefined, undefined, { polish: (_input, value) => {
    calls++; signal = value; return new Promise(done => { resolve = done; });
  } });
  await fixture.improve();
  const next = await fixture.settings.load(); next.translation.mode = 'manual'; await fixture.settings.save(next);
  assert.equal(signal.aborted, false);
  assert.equal(calls, 1);
  resolve(improved()); await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'AI improved draft');
});

test('isComposing alone pauses work and the committed input restarts a full debounce', async t => {
  let calls = 0;
  const fixture = await setup(t, async () => { calls++; return 'Translation'; });
  fixture.editor.innerText = '组合输入';
  fixture.emit('input', document, fixture.editor, fixture.editor, { isComposing: true });
  t.mock.timers.tick(5000); await settle(); assert.equal(calls, 1);
  fixture.emit('input', document, fixture.editor, fixture.editor, { isComposing: false });
  t.mock.timers.tick(899); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
});

test('explicit composition waits for compositionend even if an input reports false, then ignores the duplicate final input', async t => {
  let calls = 0;
  const fixture = await setup(t, async () => { calls++; return 'Translation'; });
  fixture.emit('compositionstart');
  fixture.editor.innerText = '输入法提交';
  fixture.emit('input', document, fixture.editor, fixture.editor, { isComposing: false });
  t.mock.timers.tick(5000); await settle(); assert.equal(calls, 1);
  fixture.emit('compositionend');
  t.mock.timers.tick(450); fixture.emit('input');
  t.mock.timers.tick(450); await settle(); assert.equal(calls, 2);
});

test('a filtered detection result is not repeated by unchanged input or DOM mutations', async t => {
  let detections = 0;
  const fixture = await setup(t, () => { throw new Error('Should not translate'); }, undefined, {
    text: 'This is long enough', pair: { source: 'en', target: 'ja' },
    detector: { detect: async () => { detections++; return { status: 'skip' }; }, reset() {}, dispose() {} },
  });
  for (let i = 0; i < 3; i++) {
    fixture.emit('input'); fixture.mutate([{ type: 'childList', target: fixture.editor }]);
    t.mock.timers.tick(1000); await settle();
  }
  assert.equal(detections, 1);
});

test('a dismissed result stays dismissed on identical input and resumes only for changed text', async t => {
  let calls = 0;
  const fixture = await setup(t, async () => { calls++; return 'Translation'; });
  await fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.title === 'Close').fire('click');
  fixture.emit('input'); fixture.mutate([{ type: 'childList', target: fixture.editor }]);
  t.mock.timers.tick(2000); await settle();
  assert.equal(fixture.overlay.isConnected, false); assert.equal(calls, 1);
  fixture.editor.innerText = '新的草稿'; fixture.emit('input');
  t.mock.timers.tick(900); await settle(); assert.equal(calls, 2);
});

test('identical text in separate composers has separate tasks and cache', async t => {
  let calls = 0;
  const fixture = await setup(t, async () => `Translation ${++calls}`, undefined, { contexts: { post: true } });
  const second = document.createElement('div'); second.contentEditable = 'true'; second.setAttribute('role', 'textbox');
  second.dataset.testid = 'tweetTextarea_1'; second.innerText = fixture.editor.innerText; document.body.append(second);
  second.focus(); fixture.emit('focusin'); await settle(); t.mock.timers.tick(900); await settle();
  assert.equal(calls, 2);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translation 2');
  fixture.editor.focus(); fixture.emit('focusin'); await settle(); t.mock.timers.tick(900); await settle();
  assert.equal(calls, 2);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translation 1');
});

test('a Chat route change while unfocused cannot reuse the previous conversation cache', async t => {
  let calls = 0;
  const fixture = await setup(t, async () => `Translation ${++calls}`, undefined, { chat: true });
  const outside = document.createElement('button'); document.body.append(outside); outside.focus(); fixture.emit('focusin');
  location.pathname = '/i/chat/900-901';
  fixture.editor.focus(); fixture.emit('focusin', document, fixture.chat.host, fixture.editor);
  await settle(); t.mock.timers.tick(900); await settle();
  assert.equal(calls, 2);
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translation 2');
});

test('newer B finishing before A keeps B and never calls AI or Replace automatically', async t => {
  const pending = [];
  let aiCalls = 0;
  const fixture = await setup(t, (text, request) => new Promise(resolve => pending.push({ text, request, resolve })), undefined, {
    polish: async () => { aiCalls++; return improved(); },
  });
  fixture.editor.innerText = '第二段文本'; fixture.emit('input');
  assert.equal(pending[0].request.signal.aborted, true);
  await fixture.replace(); assert.equal(fixture.replacements(), 0);
  t.mock.timers.tick(900); await settle();
  pending[1].resolve('B result'); await settle(); pending[0].resolve('A result'); await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'B result');
  assert.equal(fixture.editor.innerText, '第二段文本'); assert.equal(aiCalls, 0); assert.equal(fixture.replacements(), 0);
});

test('Automatic failure has no AI fallback and repeated mode changes do not duplicate listeners', async t => {
  let calls = 0;
  let aiCalls = 0;
  const fixture = await setup(t, async () => { calls++; throw new Error('local failure'); }, undefined, {
    polish: async () => { aiCalls++; return improved(); },
  });
  assert.equal(aiCalls, 0); assert.equal(calls, 1);
  for (let i = 0; i < 3; i++) {
    const next = await fixture.settings.load(); next.translation.mode = 'manual'; await fixture.settings.save(next);
    next.translation.mode = 'automatic'; await fixture.settings.save(next);
  }
  fixture.editor.innerText = '新的一次输入'; fixture.emit('input'); t.mock.timers.tick(900); await settle();
  assert.equal(calls, 2); assert.equal(aiCalls, 0); assert.equal(fixture.observerCount(), 1);
});

test('switching modes preserves an already requested manual translation without a duplicate automatic task', async t => {
  const pending = [];
  const fixture = await setup(t, (_text, request) => new Promise(resolve => pending.push({ request, resolve })), undefined, { mode: 'manual' });
  await fixture.enable();
  const next = await fixture.settings.load(); next.translation.mode = 'automatic'; await fixture.settings.save(next);
  t.mock.timers.tick(1000); await settle();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request.signal.aborted, false);
  next.translation.mode = 'manual'; await fixture.settings.save(next);
  assert.equal(pending[0].request.signal.aborted, false);
  pending[0].resolve('Requested translation'); await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Requested translation');
});

test('enabling Automatic keeps valid AI candidates and does not restart a user-initiated AI request', async t => {
  let complete;
  let signal;
  const fixture = await setup(t, undefined, undefined, { mode: 'manual', polish: (_input, value) => {
    signal = value; return new Promise(resolve => { complete = resolve; });
  } });
  await fixture.enable(); await settle(); await fixture.improve();
  const next = await fixture.settings.load(); next.translation.mode = 'automatic'; await fixture.settings.save(next);
  assert.equal(signal.aborted, false);
  complete(improved('Current AI')); await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Current AI');
});

function reports(fixture, event) { return fixture.analyticsReports.filter(report => report.event === event); }
function clickClose(fixture) { return fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.title === 'Close').fire('click'); }

test('Phase 1 starts no empty session, then one nonempty session in every writing context', async t => {
  for (const writingContext of ['post', 'reply', 'quote', 'chat']) {
    await t.test(writingContext, async t => {
      const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true, text: '', mode: 'manual', writingContext,
        contexts: { post: true, reply: true, quote: true, chat: true } });
      assert.deepEqual(fixture.analyticsReports, []);
      fixture.editor.innerText = '   '; fixture.emit('input');
      assert.deepEqual(fixture.analyticsReports, []);
      fixture.editor.innerText = '有效內容'; fixture.emit('input');
      fixture.editor.innerText = '持續編輯內容'; fixture.emit('input');
      assert.equal(reports(fixture, 'composer_session_started').length, 1);
      assert.equal(reports(fixture, 'preview_shown').length, 0);
      assert.equal(reports(fixture, 'improve_with_ai_shown').length, 0);
    });
  }
});

test('Phase 1 keeps candidate IDs through cached redisplay and uses a new ID for Retry', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true, polish: async () => improved() });
  const first = reports(fixture, 'preview_shown')[0];
  assert.equal(first.source, 'local');
  assert.equal(reports(fixture, 'improve_with_ai_shown').length, 1);
  const text = fixture.editor.innerText;
  fixture.editor.innerText = 'a different language'; fixture.emit('input');
  fixture.editor.innerText = text; fixture.emit('input');
  fixture.mutate([{ type: 'childList', target: fixture.editor }]); fixture.flushFrames();
  assert.equal(reports(fixture, 'preview_shown').length, 1);
  await fixture.retry(); await settle();
  const second = reports(fixture, 'preview_shown')[1];
  assert.notEqual(first.previewId, second.previewId);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(reports(fixture, 'composer_session_started').length, 1);
  assert.deepEqual(reports(fixture, 'translation_success').map(value => value.mode), ['automatic', 'manual']);
});

test('Phase 1 distinguishes actual AI visibility, first click, success and source replacement', async t => {
  let finish;
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true,
    polish: () => new Promise(resolve => { finish = resolve; }) });
  await fixture.improve(); await fixture.improve();
  assert.equal(reports(fixture, 'improve_with_ai_clicked').length, 1);
  assert.equal(reports(fixture, 'ai_rewrite_success').length, 0);
  finish(improved()); await settle();
  const exposures = reports(fixture, 'preview_shown');
  assert.deepEqual(exposures.map(value => value.source), ['local', 'ai']);
  assert.notEqual(exposures[0].previewId, exposures[1].previewId);
  assert.equal(reports(fixture, 'ai_rewrite_success')[0].previewId, exposures[1].previewId);
  await fixture.selectPreview('Local'); await fixture.selectPreview('AI Improved');
  assert.equal(reports(fixture, 'preview_shown').length, 2);
  assert.equal(reports(fixture, 'improve_with_ai_shown').length, 1);
  await fixture.replace(); await fixture.replace();
  assert.equal(reports(fixture, 'replace_success').length, 1);
  assert.equal(reports(fixture, 'replace_success')[0].source, 'ai');
  assert.equal(reports(fixture, 'ai_improve_replaced').length, 0);
  assert.equal(reports(fixture, 'preview_dismissed').length, 0);
  assert.equal(new Set(fixture.analyticsReports.map(value => value.eventId)).size, fixture.analyticsReports.length);
  const serialized = JSON.stringify(fixture.analyticsReports);
  assert.ok(!serialized.includes('這是一段測試文字'));
  assert.ok(!serialized.includes('Translated draft'));
});

test('Phase 1 counts the click even when AI fails and excludes cancellation and stale failures', async t => {
  const pending = [];
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true,
    polish: () => new Promise((_resolve, reject) => pending.push(reject)) });
  await fixture.improve(); pending[0](new Error('real failure')); await settle();
  assert.equal(reports(fixture, 'ai_rewrite_error').length, 1);
  assert.equal(reports(fixture, 'improve_with_ai_clicked').length, 1);
  await fixture.improve(); pending[1](new DOMException('cancel', 'AbortError')); await settle();
  assert.equal(reports(fixture, 'ai_rewrite_error').length, 1);
  await fixture.improve();
  fixture.editor.innerText = '內容已經改變'; fixture.emit('input');
  pending[2](new Error('stale failure')); await settle();
  assert.equal(reports(fixture, 'ai_rewrite_error').length, 1);
  assert.equal(reports(fixture, 'improve_with_ai_clicked').length, 1);
});

test('Phase 1 records only an explicit candidate dismissal and preserves its session', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true });
  const shown = reports(fixture, 'preview_shown')[0];
  await clickClose(fixture); await clickClose(fixture);
  assert.equal(reports(fixture, 'preview_dismissed').length, 1);
  assert.equal(reports(fixture, 'preview_dismissed')[0].previewId, shown.previewId);
  await fixture.retry(); await settle();
  assert.equal(reports(fixture, 'composer_session_started').length, 1);
  fixture.invalidate();
  assert.equal(reports(fixture, 'preview_dismissed').length, 1);
});

test('Phase 1 ends a cleared draft even while unfocused and gives the next draft a new ID', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true });
  const first = reports(fixture, 'composer_session_started')[0];
  document.body.focus(); fixture.emit('focusin');
  fixture.editor.innerText = ''; fixture.mutate([{ type: 'childList', target: fixture.editor }]);
  fixture.editor.innerText = '新草稿'; fixture.editor.focus(); fixture.emit('focusin'); await settle();
  fixture.emit('input');
  const starts = reports(fixture, 'composer_session_started');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[1].sessionId, first.sessionId);
});

test('Phase 1 keeps separate IDs for composers and does not restart on focus return', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true, mode: 'manual', writingContext: 'post', contexts: { post: true } });
  const second = document.createElement('div');
  second.contentEditable = 'true'; second.setAttribute('role', 'textbox'); second.dataset.testid = 'tweetTextarea_1';
  second.innerText = '第二個草稿'; fixture.editor.parentElement.append(second);
  second.focus(); fixture.emit('focusin'); await settle(); fixture.emit('input');
  fixture.editor.focus(); fixture.emit('focusin'); await settle(); fixture.emit('input');
  const starts = reports(fixture, 'composer_session_started');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].sessionId, starts[1].sessionId);
});

test('Phase 1 opt-out stops all new events and re-enable never reuses session identity', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true, polish: async () => improved() });
  const originalId = reports(fixture, 'composer_session_started')[0].sessionId;
  const next = await fixture.settings.load(); next.analytics.enabled = false; await fixture.settings.save(next);
  const count = fixture.analyticsReports.length;
  await fixture.improve(); await settle(); await fixture.selectPreview('Local');
  assert.equal(fixture.analyticsReports.length, count);
  next.analytics.enabled = true; await fixture.settings.save(next);
  await fixture.replace();
  assert.equal(fixture.analyticsReports.length, count);
  fixture.editor.innerText = '重新啟用後新內容'; fixture.emit('input'); t.mock.timers.tick(1000); await settle();
  assert.notEqual(reports(fixture, 'composer_session_started').at(-1).sessionId, originalId);
});

test('Phase 1 never exposes or counts an empty local result', async t => {
  const fixture = await setup(t, async () => '   ', undefined, { analyticsEnabled: true });
  assert.equal(reports(fixture, 'translation_success').length, 0);
  assert.equal(reports(fixture, 'translation_error').length, 0);
  assert.equal(reports(fixture, 'preview_shown').length, 0);
});

test('Phase 1 emits no exposure when the existing overlay cannot be attached', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true });
  const count = reports(fixture, 'preview_shown').length;
  fixture.editor.remove();
  await fixture.retry(); await settle();
  assert.equal(reports(fixture, 'preview_shown').length, count);
});


test('Phase 1 never counts an empty AI result as a new candidate or successful rewrite', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true, polish: async () => ({ ...improved(), text: '   ' }) });
  await fixture.improve(); await settle();
  assert.equal(reports(fixture, 'ai_rewrite_success').length, 0);
  assert.equal(reports(fixture, 'preview_shown').length, 1);
  assert.equal(reports(fixture, 'improve_with_ai_clicked').length, 1);
});
