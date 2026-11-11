import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../load-ts.mjs';

const { createChromeTranslationProvider } = await loadTs('translators/chrome.ts');
const { getTranslationProvider } = await loadTs('translators/registry.ts');
const signal = () => new AbortController().signal;
const translate = (provider, activated = false, progress = () => {}, pair = { source: 'zh', target: 'en' }) => provider.translate('你好', {
  ...pair,
  signal: signal(),
  activated,
  onProgress: progress,
});

test('registry resolves the Chrome provider', () => {
  assert.equal(getTranslationProvider('chrome').id, 'chrome');
});

test('missing API and unsupported language pair produce actionable states', async () => {
  delete globalThis.Translator;
  await assert.rejects(translate(createChromeTranslationProvider()), { kind: 'unsupported' });
  globalThis.Translator = { availability: async () => 'unavailable' };
  await assert.rejects(translate(createChromeTranslationProvider()), { kind: 'unsupported' });
});

test('download requires activation, progress is forwarded, instance is reused', async () => {
  let creations = 0;
  globalThis.Translator = {
    availability: async () => 'downloadable',
    create: async ({ monitor }) => {
      creations++;
      monitor({ addEventListener: (_, listener) => listener({ loaded: .5 }) });
      return { translate: async () => 'Hello', destroy() {} };
    },
  };
  const provider = createChromeTranslationProvider();
  await assert.rejects(translate(provider), { kind: 'enable' });
  assert.equal(creations, 0);
  const progress = [];
  assert.equal(await translate(provider, true, value => progress.push(value)), 'Hello');
  assert.equal(await translate(provider), 'Hello');
  assert.deepEqual(progress, [50]);
  assert.equal(creations, 1);
  provider.dispose();
});

test('concurrent requests share initialization; aborted text is never translated', async () => {
  let resolveCreate;
  let creations = 0;
  const texts = [];
  globalThis.Translator = {
    availability: async () => 'available',
    create: () => { creations++; return new Promise(resolve => { resolveCreate = resolve; }); },
  };
  const provider = createChromeTranslationProvider();
  const aborted = new AbortController();
  const first = provider.translate('旧文本', { source: 'zh', target: 'en', signal: aborted.signal, activated: true, onProgress: () => {} });
  const assertion = assert.rejects(first, { name: 'AbortError' });
  const second = translate(provider, true);
  aborted.abort();
  resolveCreate({ translate: async text => { texts.push(text); return 'Hello'; }, destroy() {} });
  await assertion;
  assert.equal(await second, 'Hello');
  assert.equal(creations, 1);
  assert.deepEqual(texts, ['你好']);
});

test('failed creation can retry, permission and support failures keep their states', async () => {
  let attempts = 0;
  globalThis.Translator = {
    create: async () => {
      if (++attempts === 1) throw new DOMException('activation', 'NotAllowedError');
      return { translate: async () => 'Hello', destroy() {} };
    },
  };
  const provider = createChromeTranslationProvider();
  await assert.rejects(translate(provider, true), { kind: 'enable' });
  assert.equal(await translate(provider, true), 'Hello');

  globalThis.Translator = { create: async () => { throw new DOMException('nope', 'NotSupportedError'); } };
  await assert.rejects(translate(createChromeTranslationProvider(), true), { kind: 'unsupported' });
});

test('translation errors and empty responses do not escape as raw errors', async () => {
  for (const result of ['empty', 'error']) {
    globalThis.Translator = {
      create: async () => ({ translate: async () => {
        if (result === 'error') throw new DOMException('test', 'OperationError');
        return ' ';
      }, destroy() {} }),
    };
    await assert.rejects(translate(createChromeTranslationProvider(), true), { kind: 'error' });
  }
});

test('downloading and unknown availability stay explicit', async () => {
  let created = 0;
  globalThis.Translator = {
    availability: async () => 'downloading',
    create: async () => { created += 1; return { translate: async () => 'Hello', destroy() {} }; },
  };
  await assert.rejects(translate(createChromeTranslationProvider()), /downloading/);
  assert.equal(created, 0);
  globalThis.Translator = { availability: async () => 'not-a-state' };
  await assert.rejects(translate(createChromeTranslationProvider()), { kind: 'unsupported' });
});

test('a hung translation reports a timeout instead of hanging forever', async () => {
  globalThis.Translator = {
    create: async () => ({ translate: async () => { throw new DOMException('slow', 'TimeoutError'); }, destroy() {} }),
  };
  await assert.rejects(translate(createChromeTranslationProvider(), true), /timed out/);
});

test('retaining one language pair destroys the others', async () => {
  const destroyed = [];
  globalThis.Translator = {
    availability: async () => 'available',
    create: async ({ sourceLanguage, targetLanguage }) => {
      const pair = `${sourceLanguage}->${targetLanguage}`;
      return { translate: async () => pair, destroy() { destroyed.push(pair); } };
    },
  };
  const provider = createChromeTranslationProvider();
  assert.equal(await translate(provider), 'zh->en');
  assert.equal(await translate(provider, false, () => {}, { source: 'ja', target: 'en' }), 'ja->en');
  provider.retainPair('ja', 'en');
  assert.deepEqual(destroyed, ['zh->en']);
  assert.equal(await translate(provider, false, () => {}, { source: 'zh', target: 'en' }), 'zh->en');
  provider.dispose();
});

test('disposing while the model loads destroys the eventual instance', async () => {
  let resolveCreate;
  let destroyed = false;
  globalThis.Translator = { create: () => new Promise(resolve => { resolveCreate = resolve; }) };
  const provider = createChromeTranslationProvider();
  const pending = translate(provider, true);
  const assertion = assert.rejects(pending, { name: 'AbortError' });
  provider.dispose();
  resolveCreate({ translate: async () => 'Hello', destroy() { destroyed = true; } });
  await assertion;
  assert.equal(destroyed, true);
});

test('availability and creation receive the requested language pair', async () => {
  const seen = [];
  globalThis.Translator = {
    availability: async options => { seen.push(options); return 'available'; },
    create: async options => { seen.push(options); return { translate: async () => 'Hello', destroy() {} }; },
  };
  assert.equal(await translate(createChromeTranslationProvider(), false, () => {}, { source: 'zh', target: 'en' }), 'Hello');
  assert.deepEqual(seen[0], { sourceLanguage: 'zh', targetLanguage: 'en' });
  assert.equal(seen[1].sourceLanguage, 'zh');
  assert.equal(seen[1].targetLanguage, 'en');
});

test('sequential requests reuse only an instance with the same language pair', async () => {
  const created = [], destroyed = [];
  globalThis.Translator = {
    availability: async () => 'available',
    create: async ({ sourceLanguage, targetLanguage }) => {
      const pair = `${sourceLanguage}->${targetLanguage}`;
      created.push(pair);
      return { translate: async () => pair, destroy() { destroyed.push(pair); } };
    },
  };
  const provider = createChromeTranslationProvider();
  assert.equal(await translate(provider), 'zh->en');
  assert.equal(await translate(provider, false, () => {}, { source: 'zh', target: 'ja' }), 'zh->ja');
  assert.equal(await translate(provider), 'zh->en');
  assert.deepEqual(created, ['zh->en', 'zh->ja']);
  provider.dispose();
  assert.deepEqual(destroyed, ['zh->en', 'zh->ja']);
});

test('concurrent language pairs isolate initialization and download progress', async () => {
  const pending = new Map();
  globalThis.Translator = {
    create: ({ targetLanguage, monitor }) => {
      const item = {};
      monitor({ addEventListener: (_, listener) => { item.progress = listener; } });
      pending.set(targetLanguage, item);
      return new Promise(resolve => { item.resolve = resolve; });
    },
  };
  const provider = createChromeTranslationProvider();
  const englishProgress = [], japaneseProgress = [];
  const english = translate(provider, true, value => englishProgress.push(value));
  const japanese = translate(provider, true, value => japaneseProgress.push(value), { source: 'zh', target: 'ja' });
  assert.equal(pending.size, 2);
  pending.get('en').progress({ loaded: .25 });
  pending.get('ja').progress({ loaded: .75 });
  pending.get('ja').resolve({ translate: async () => 'Japanese', destroy() {} });
  pending.get('en').resolve({ translate: async () => 'English', destroy() {} });
  assert.deepEqual(await Promise.all([english, japanese]), ['English', 'Japanese']);
  assert.deepEqual(englishProgress, [25]);
  assert.deepEqual(japaneseProgress, [75]);
  provider.dispose();
});
