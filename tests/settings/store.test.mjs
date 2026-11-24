import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTs } from '../load-ts.mjs';

const {
  createMemoryBackend,
  createSettingsStore,
  getDefaultSettings,
  normalizeSettings,
  sameSettings,
} = await loadTs('settings/store.ts');

test('a first run and an upgrade with no saved settings keep Chinese to English and every X context', () => {
  const defaults = getDefaultSettings();
  assert.deepEqual(defaults, {
    schemaVersion: 1,
    translation: { mode: 'automatic', sourceLanguage: 'zh', targetLanguage: 'en' },
    contexts: { x: { post: true, reply: true, quote: true, chat: true } },
    analytics: { enabled: false },
  });
  for (const stored of [undefined, null, {}, { schemaVersion: 1 }]) {
    assert.deepEqual(normalizeSettings(stored), defaults);
  }
});

test('saved settings round-trip and sync across two readers', async () => {
  const backend = createMemoryBackend();
  const first = createSettingsStore(backend);
  const second = createSettingsStore(backend);
  const seen = [];
  second.subscribe(value => seen.push(value));
  const next = normalizeSettings({
    translation: { sourceLanguage: 'ja', targetLanguage: 'en' },
    contexts: { x: { post: true, reply: false, quote: true, chat: true } },
  });
  await first.save(next);
  assert.deepEqual(await first.load(), next);
  assert.deepEqual(await second.load(), next);
  assert.equal(sameSettings(seen.at(-1), next), true);
  const reopened = createSettingsStore(createMemoryBackend(backend.current()));
  assert.deepEqual(await reopened.load(), next);
});

test('upgrading saved settings enables Chat without changing languages, consent or existing contexts', async () => {
  const saved = {
    schemaVersion: 1,
    translation: { sourceLanguage: 'ja', targetLanguage: 'fr' },
    contexts: { x: { post: false, reply: true, quote: false } },
    analytics: { enabled: true },
  };
  const backend = createMemoryBackend(saved);
  const store = createSettingsStore(backend);
  const upgraded = await store.load();
  assert.deepEqual(upgraded, { ...saved, translation: { ...saved.translation, mode: 'automatic' }, contexts: { x: { ...saved.contexts.x, chat: true } } });
  assert.deepEqual(backend.current(), saved, 'loading settings does not reset or rewrite storage');
  upgraded.contexts.x.chat = false;
  assert.equal(sameSettings(upgraded, await store.load()), false);
  await store.save(upgraded);
  assert.deepEqual(await createSettingsStore(createMemoryBackend(backend.current())).load(), upgraded);
});

test('equal languages and corrupt storage fall back without throwing', () => {
  assert.deepEqual(normalizeSettings({
    translation: { sourceLanguage: 'en', targetLanguage: 'en' },
  }).translation, { mode: 'automatic', sourceLanguage: 'en', targetLanguage: 'zh' });
  assert.deepEqual(normalizeSettings({
    translation: { sourceLanguage: 'nope', targetLanguage: 4 },
    contexts: { x: { post: 'yes', reply: false, quote: null } },
  }), {
    schemaVersion: 1,
    translation: { mode: 'automatic', sourceLanguage: 'zh', targetLanguage: 'en' },
    contexts: { x: { post: true, reply: false, quote: true, chat: true } },
    analytics: { enabled: false },
  });
  assert.equal(normalizeSettings({ translation: { sourceLanguage: 'fr' } }).translation.targetLanguage, 'en');
  assert.deepEqual(normalizeSettings('broken'), getDefaultSettings());
});

test('storage reads local extension settings and does not add a network client', async () => {
  const source = await readFile(new URL('../../settings/chrome.ts', import.meta.url), 'utf8');
  assert.match(source, /browser\.storage\.local/);
  const keys = await readFile(new URL('../../settings/keys.ts', import.meta.url), 'utf8');
  assert.match(keys, /SETTINGS_STORAGE_KEY = 'settings'/);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|WebSocket|analytics|telemetry/);
});

test('analytics consent requires an explicit boolean on the supported settings schema', async () => {
  for (const analytics of [undefined, null, true, [], {}, { enabled: 'true' }, { enabled: 1 }]) {
    assert.equal(normalizeSettings({ schemaVersion: 1, analytics }).analytics.enabled, false);
  }
  assert.equal(normalizeSettings({ analytics: { enabled: true } }).analytics.enabled, false);
  assert.equal(normalizeSettings({ schemaVersion: 2, analytics: { enabled: true } }).analytics.enabled, false);
  const backend = createMemoryBackend();
  const first = createSettingsStore(backend);
  const second = createSettingsStore(backend);
  const seen = [];
  second.subscribe(value => seen.push(value.analytics.enabled));
  const next = getDefaultSettings();
  next.analytics.enabled = true;
  assert.equal(sameSettings(next, getDefaultSettings()), false);
  await first.save(next);
  assert.equal((await second.load()).analytics.enabled, true);
  assert.equal((await createSettingsStore(createMemoryBackend(backend.current())).load()).analytics.enabled, true);
  next.analytics.enabled = false;
  await first.save(next);
  assert.deepEqual(seen, [true, false]);
});

test('Translation Mode defaults safely for legacy and invalid values and persists across readers', async () => {
  for (const mode of [undefined, null, '', 'auto', true, 1]) {
    assert.equal(normalizeSettings({ translation: { mode } }).translation.mode, 'automatic');
  }
  for (const mode of ['manual', 'automatic']) {
    assert.equal(normalizeSettings({ translation: { mode } }).translation.mode, mode);
  }
  const backend = createMemoryBackend({ schemaVersion: 1, translation: { sourceLanguage: 'ja', targetLanguage: 'en' } });
  const first = createSettingsStore(backend);
  assert.equal((await first.load()).translation.mode, 'automatic');
  const next = await first.load();
  next.translation.mode = 'manual';
  assert.equal(sameSettings(next, await first.load()), false);
  const notifications = [];
  const stop = first.subscribe(value => notifications.push(value.translation.mode));
  await first.save(next);
  assert.equal((await createSettingsStore(backend).load()).translation.mode, 'manual');
  assert.equal((await createSettingsStore(createMemoryBackend(backend.current())).load()).translation.mode, 'manual');
  next.translation.mode = 'automatic';
  await first.save(next);
  assert.deepEqual(notifications, ['manual', 'automatic']);
  stop();
});
