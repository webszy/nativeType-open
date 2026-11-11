import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../load-ts.mjs';
import { settle } from '../dom-fixture.mjs';

const { createTriggerDetector, interpretDetection } = await loadTs('languages/detector.ts');
const signal = () => new AbortController().signal;
const request = (activated = false, progress = () => {}) => ({ signal: signal(), activated, onProgress: progress });

test('low confidence, mixed results, and the wrong language do not match', () => {
  assert.equal(interpretDetection([{ detectedLanguage: 'en', confidence: 0.99 }], 'en', 20), 'match');
  assert.equal(interpretDetection([{ detectedLanguage: 'ja', confidence: 0.99 }], 'en', 20), 'skip');
  assert.equal(interpretDetection([{ detectedLanguage: 'en', confidence: 0.62 }], 'en', 20), 'skip');
  assert.equal(interpretDetection([{ detectedLanguage: 'en', confidence: 0.84 }], 'en', 8), 'skip');
  assert.equal(interpretDetection([
    { detectedLanguage: 'en', confidence: 0.55 },
    { detectedLanguage: 'es', confidence: 0.4 },
  ], 'en', 20), 'skip');
  assert.equal(interpretDetection([{ detectedLanguage: 'zh-TW', confidence: 0.96 }], 'zh-Hant', 12), 'match');
  assert.equal(interpretDetection([{ detectedLanguage: 'zh', confidence: 0.99 }], 'zh-Hant', 12), 'unavailable');
});

test('a missing detector explains that NativeType will not guess', async () => {
  delete globalThis.LanguageDetector;
  delete globalThis.ai;
  const detector = createTriggerDetector();
  const outcome = await detector.detect('Hello world', 'en', request());
  assert.equal(outcome.status, 'unavailable');
  assert.match(outcome.message, /will not guess/);
});

test('downloadable detection waits for an explicit enable click', async () => {
  let created = 0;
  globalThis.LanguageDetector = {
    availability: async () => 'downloadable',
    create: async () => { created += 1; return { detect: async () => [{ detectedLanguage: 'en', confidence: 0.99 }], destroy() {} }; },
  };
  const detector = createTriggerDetector();
  const blocked = await detector.detect('Hello world', 'en', request(false));
  assert.equal(blocked.status, 'enable');
  assert.equal(created, 0);
  const progress = [];
  globalThis.LanguageDetector = {
    availability: async () => 'available',
    create: async ({ monitor }) => {
      created += 1;
      monitor({ addEventListener: (_, listener) => listener({ loaded: 0.5 }) });
      return { detect: async () => [{ detectedLanguage: 'en', confidence: 0.99 }], destroy() {} };
    },
  };
  const enabled = createTriggerDetector();
  enabled.prepare('en', value => progress.push(value));
  assert.equal((await enabled.detect('Hello world', 'en', request(true, value => progress.push(value)))).status, 'match');
  assert.deepEqual(progress, [50]);
  assert.equal(created, 1);
  enabled.dispose();
});

test('an available detector skips other languages and can be reset', async () => {
  const seen = [];
  globalThis.LanguageDetector = {
    availability: async () => 'available',
    create: async options => {
      seen.push(options.expectedInputLanguages);
      return {
        detect: async text => [{ detectedLanguage: text.startsWith('Hello') ? 'en' : 'ja', confidence: 0.99 }],
        destroy() { seen.push('destroy'); },
      };
    },
  };
  const detector = createTriggerDetector();
  assert.equal((await detector.detect('Hello world', 'en', request())).status, 'match');
  assert.equal((await detector.detect('こんにちは世界', 'en', request())).status, 'skip');
  assert.deepEqual(seen, [['en']]);
  detector.reset();
  assert.equal((await detector.detect('Hello world', 'ja', request())).status, 'skip');
  assert.deepEqual(seen[1], 'destroy');
  assert.deepEqual(seen[2], ['ja']);
  detector.dispose();
});

test('short or noisy text never calls the detector', async () => {
  let called = false;
  globalThis.LanguageDetector = { availability: async () => { called = true; return 'available'; } };
  const detector = createTriggerDetector();
  assert.equal((await detector.detect('OK', 'en', request())).status, 'skip');
  assert.equal((await detector.detect('https://x.com @sam 🔥', 'en', request())).status, 'skip');
  assert.equal(called, false);
});

test('generic Chinese detection explains the Chrome upgrade needed for a Traditional trigger', async () => {
  globalThis.LanguageDetector = {
    availability: async () => 'available',
    create: async () => ({ detect: async () => [{ detectedLanguage: 'zh', confidence: 0.99 }], destroy() {} }),
  };
  const detector = createTriggerDetector();
  const outcome = await detector.detect('這是一段繁體中文測試文字', 'zh-Hant', request());
  assert.equal(outcome.status, 'unavailable');
  assert.match(outcome.message, /Chrome 151 or later/);
  assert.match(outcome.message, /choose Chinese/);
  detector.dispose();
});

test('script-aware detection matches Traditional Chinese and skips Simplified or uncertain Chinese', async () => {
  const results = [
    [{ detectedLanguage: 'zh-Hant', confidence: 0.99 }],
    [{ detectedLanguage: 'zh-Hans', confidence: 0.99 }],
    [{ detectedLanguage: 'zh', confidence: 0.4 }],
  ];
  globalThis.LanguageDetector = {
    availability: async () => 'available',
    create: async () => ({ detect: async () => results.shift(), destroy() {} }),
  };
  const detector = createTriggerDetector();
  const text = '這是一段繁體中文測試文字';
  assert.equal((await detector.detect(text, 'zh-Hant', request())).status, 'match');
  assert.equal((await detector.detect(text, 'zh-Hant', request())).status, 'skip');
  assert.equal((await detector.detect(text, 'zh-Hant', request())).status, 'skip');
  detector.dispose();
});

test('failed detector creation is handled and can be retried without an unhandled rejection', async () => {
  let attempts = 0;
  globalThis.LanguageDetector = {
    availability: async () => 'available',
    create: async () => {
      if (++attempts === 1) throw new DOMException('activation', 'NotAllowedError');
      return { detect: async () => [{ detectedLanguage: 'en', confidence: 0.99 }], destroy() {} };
    },
  };
  const detector = createTriggerDetector();
  assert.equal((await detector.detect('Hello world', 'en', request())).status, 'enable');
  await settle(); // node:test also fails if the cleanup promise rejects unhandled.
  assert.equal((await detector.detect('Hello world', 'en', request(true))).status, 'match');
  detector.dispose();
});

test('reset during creation destroys the old detector without an unhandled rejection', async () => {
  let finishCreate;
  let destroyed = 0;
  globalThis.LanguageDetector = { create: () => new Promise(resolve => { finishCreate = resolve; }) };
  const detector = createTriggerDetector();
  const pending = detector.detect('Hello world', 'en', request(true));
  detector.reset();
  finishCreate({ detect: async () => [], destroy() { destroyed += 1; } });
  assert.equal((await pending).status, 'skip');
  await settle();
  assert.equal(destroyed, 1);
  detector.dispose();
});
