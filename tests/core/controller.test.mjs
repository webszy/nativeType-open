import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, settle } from '../dom-fixture.mjs';
import { loadTs } from '../load-ts.mjs';
import { attachedPost, chatComposer } from '../platforms/x-fixture.mjs';

const { startNativeType } = await loadTs('core/controller.ts');
const { xPlatform } = await loadTs('platforms/x.ts');
const { createMemoryBackend, createSettingsStore, getDefaultSettings } = await loadTs('settings/store.ts');
const { TranslationError } = await loadTs('translators/types.ts');

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
  settings.translation = { sourceLanguage: pair.source, targetLanguage: pair.target };
  settings.analytics.enabled = options.analyticsEnabled ?? false;
  const analyticsEvents = [];
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
    analytics: options.analytics ?? (event => { analyticsEvents.push(event); }),
    settings: store,
    host: {
      listen: (target, type, listener) => listeners.push({ target, type, listener }),
      onInvalidated(listener) { invalidate = listener; dom.onCleanup(listener); },
      openSettings: options.openSettings,
    },
  });
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  dom.flushFrames();
  const overlay = document.body.querySelector('[data-nativetype]');
  return {
    ...dom, editor, postEditor, chat, overlay, settings: store, retainedPairs, analyticsEvents,
    disposals: () => disposals,
    invalidate: () => invalidate(),
    emit(type, target = document, eventTarget = document.activeElement, composedTarget = eventTarget) {
      for (const item of listeners) if (item.type === type && item.target === target) item.listener({ target: eventTarget, composedPath: () => [composedTarget] });
    },
    replacements: () => replacements,
    signal: () => signal,
    replace: () => overlay.shadowRoot.querySelectorAll('button').find(button => button.textContent === 'Replace').fire('click'),
    retry: () => overlay.shadowRoot.querySelectorAll('button').find(button => button.textContent === 'Retry').fire('click'),
    removeQuote(notify = true) {
      quote.remove();
      if (notify) dom.mutate([{ type: 'childList', target: attachment }]);
    },
  };
}

test('removing a quote without editing text hides the preview and restores input height', async t => {
  const fixture = await setup(t);
  assert.equal(fixture.overlay.style.display, 'block');
  assert.notEqual(fixture.editor.style.getPropertyValue('min-height'), '');
  fixture.removeQuote();
  assert.equal(fixture.overlay.style.display, 'none');
  assert.equal(fixture.editor.style.getPropertyValue('min-height'), '');
  await fixture.replace();
  assert.equal(fixture.replacements(), 0);
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
});

test('analytics counts one completed translation across DOM refresh and cached preview reuse', async t => {
  let calls = 0;
  const fixture = await setup(t, async () => { calls += 1; return 'Translated draft'; }, undefined, { analyticsEnabled: true });
  assert.deepEqual(fixture.analyticsEvents, ['translation_success']);
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
  assert.deepEqual(fixture.analyticsEvents, ['translation_success']);
});

test('new input and explicit Retry are separate successful translation operations', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true });
  fixture.editor.innerText = '這是新的內容';
  fixture.emit('input', document, fixture.editor);
  t.mock.timers.tick(1000);
  await settle();
  await fixture.retry();
  await settle();
  assert.deepEqual(fixture.analyticsEvents, Array(3).fill('translation_success'));
});

test('Replace only reports after the verified operation succeeds and cannot double count', async t => {
  let complete;
  const fixture = await setup(t, undefined, (editor, _source, translation) => new Promise(resolve => {
    complete = () => { editor.innerText = translation; resolve(true); };
  }), { analyticsEnabled: true });
  const replacing = fixture.replace();
  await settle();
  assert.deepEqual(fixture.analyticsEvents, ['translation_success']);
  complete();
  await replacing;
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'Translated draft');
  assert.deepEqual(fixture.analyticsEvents, ['translation_success', 'replace_success']);
});

test('a failed Replace reports neither replacement success nor translation failure', async t => {
  const fixture = await setup(t, undefined, async () => false, { analyticsEnabled: true });
  await fixture.replace();
  assert.deepEqual(fixture.analyticsEvents, ['translation_success']);
  assert.equal(fixture.editor.innerText, '這是一段測試文字');
});

test('terminal translation failure counts once and Retry can then count success', async t => {
  let failing = true;
  const fixture = await setup(t, async () => {
    if (failing) throw new TranslationError('error', 'Translation failed. Please retry.');
    return 'Recovered translation';
  }, undefined, { analyticsEnabled: true });
  assert.deepEqual(fixture.analyticsEvents, ['translation_error']);
  failing = false;
  await fixture.retry();
  await settle();
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Recovered translation');
  assert.deepEqual(fixture.analyticsEvents, ['translation_error', 'translation_success']);
});

test('a model-unavailable translation attempt counts as a terminal error', async t => {
  const fixture = await setup(t, async () => { throw new TranslationError('unsupported', 'Model unavailable'); }, undefined, { analyticsEnabled: true });
  assert.deepEqual(fixture.analyticsEvents, ['translation_error']);
});

test('waiting for model activation is not a translation error', async t => {
  const fixture = await setup(t, async () => { throw new TranslationError('enable', 'Enable translation'); }, undefined, { analyticsEnabled: true });
  assert.deepEqual(fixture.analyticsEvents, []);
});

test('an aborted execution never counts as a translation error', async t => {
  const fixture = await setup(t, async () => { throw new DOMException('Cancelled', 'AbortError'); }, undefined, { analyticsEnabled: true });
  assert.deepEqual(fixture.analyticsEvents, []);
});

test('closing Preview cancels a pending operation without reporting late success', async t => {
  let complete;
  const fixture = await setup(t, () => new Promise(resolve => { complete = resolve; }), undefined, { analyticsEnabled: true });
  const close = fixture.overlay.shadowRoot.querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'Close translation preview');
  await close.fire('click');
  complete('Late translation');
  await settle();
  assert.deepEqual(fixture.analyticsEvents, []);
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
  assert.deepEqual(fixture.analyticsEvents, []);
  pending[1]('Current translation');
  await settle();
  assert.deepEqual(fixture.analyticsEvents, ['translation_success']);
});

test('a normal editor removal suppresses a late execution error', async t => {
  let fail;
  const fixture = await setup(t, () => new Promise((_resolve, reject) => { fail = reject; }), undefined, { analyticsEnabled: true });
  fixture.editor.remove();
  fail(new Error('Late failure'));
  await settle();
  assert.deepEqual(fixture.analyticsEvents, []);
});

test('language detection failure before translation starts is not a translation event', async t => {
  let translated = false;
  const fixture = await setup(t, async () => { translated = true; return 'translation'; }, undefined, {
    analyticsEnabled: true, text: 'This is enough English text for detection', pair: { source: 'en', target: 'ja' },
    detector: { detect: async () => ({ status: 'error', message: 'Detection failed' }), dispose() {}, reset() {} },
  });
  assert.equal(translated, false);
  assert.deepEqual(fixture.analyticsEvents, []);
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
  assert.deepEqual(events, ['translation_success', 'replace_success']);
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
  assert.deepEqual(events, ['translation_success', 'replace_success']);
});

test('a hung analytics promise never delays Preview or Replace', async t => {
  const fixture = await setup(t, undefined, undefined, { analyticsEnabled: true, analytics: () => new Promise(() => {}) });
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
  await fixture.replace();
  assert.equal(fixture.editor.innerText, 'Translated draft');
});

test('already-open X tabs follow opt-in changes without retransmitting an old Preview', async t => {
  const fixture = await setup(t);
  assert.deepEqual(fixture.analyticsEvents, []);
  const next = await fixture.settings.load();
  next.analytics.enabled = true;
  await fixture.settings.save(next);
  assert.deepEqual(fixture.analyticsEvents, []);
  await fixture.retry();
  await settle();
  assert.deepEqual(fixture.analyticsEvents, ['translation_success']);
  next.analytics.enabled = false;
  await fixture.settings.save(next);
  await fixture.replace();
  assert.deepEqual(fixture.analyticsEvents, ['translation_success']);
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
  assert.equal(fixture.overlay.shadowRoot.querySelector('p').textContent, 'Translated draft');
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
  next.translation = { sourceLanguage: 'zh-Hant', targetLanguage: 'ja' };
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
  assert.notEqual(fixture.overlay.style.display, 'block');
  const next = await fixture.settings.load();
  next.contexts.x.quote = true;
  await fixture.settings.save(next);
  fixture.emit('focusin');
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  fixture.flushFrames();
  assert.equal(fixture.overlay.style.display, 'block');
});

function delayedSettings() {
  const initial = getDefaultSettings();
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
  settings.pending[0]({ ...settings.initial, translation: { sourceLanguage: 'zh', targetLanguage: 'ja' } });
  await settle();
  assert.equal(settings.pending.length, 2);
  assert.deepEqual(fixture.retainedPairs, []);
  assert.equal(fixture.overlay.style.display, 'none');
  settings.pending[1]({ ...settings.initial, translation: { sourceLanguage: 'zh', targetLanguage: 'ko' } });
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
  settings.notify({ ...settings.initial, translation: { sourceLanguage: 'zh', targetLanguage: 'fr' } });
  settings.pending[0]({ ...settings.initial, translation: { sourceLanguage: 'zh', targetLanguage: 'ja' } });
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
  settings.pending[0]({ ...settings.initial, translation: { sourceLanguage: 'zh', targetLanguage: 'ja' } });
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
  assert.match(fixture.overlay.shadowRoot.querySelector('header').textContent, /Chinese → Japanese/);
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
  assert.match(settingsButton.title, /Couldn’t open settings/);
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
  assert.deepEqual(fixture.analyticsEvents, ['translation_success', 'replace_success']);
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
  assert.equal(document.body.querySelectorAll('[data-nativetype]').length, 1);
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
  assert.equal(fixture.resizeTargetCount(), 1, 'only the reusable preview panel remains observed');
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
