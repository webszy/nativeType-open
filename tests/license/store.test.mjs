import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTs } from '../load-ts.mjs';

const { createLicenseStore, createMemoryLicenseBackend, normalizeStoredLicense } = await loadTs('license/store.ts');

test('missing and corrupt license records restore as free without dropping a usable key', () => {
  assert.equal(normalizeStoredLicense(undefined), null);
  assert.equal(normalizeStoredLicense({ licenseKey: '   ' }), null);
  assert.equal(normalizeStoredLicense({ email: 'person@example.com' }), null);
  const raw = {
    licenseKey: '  NT-DEV-MONTHLY  ',
    email: 'person@example.com',
    lastVerifiedAt: '2026-11-14T00:00:00.000Z',
    lastVerification: { status: 'active', plan: 'lifetime', validUntil: null, extra: true },
  };
  assert.deepEqual(normalizeStoredLicense(raw), {
    licenseKey: 'NT-DEV-MONTHLY',
    lastVerifiedAt: '2026-11-14T00:00:00.000Z',
    lastVerification: { status: 'active', validUntil: null },
  });
  assert.deepEqual(normalizeStoredLicense({
    licenseKey: 'kept',
    lastVerification: { status: 'nope', plan: 'monthly' },
  }), { licenseKey: 'kept' });
});

test('license storage round-trips independently of translation settings', async () => {
  const saved = {
    licenseKey: 'NT-DEV-MONTHLY',
    lastVerifiedAt: '2026-11-14T00:00:00.000Z',
    lastVerification: { status: 'active', plan: 'monthly', validUntil: '2026-12-14T00:00:00.000Z' },
  };
  const backend = createMemoryLicenseBackend(saved);
  const store = createLicenseStore(backend);
  assert.deepEqual(await store.load(), saved);
  assert.equal(backend.current(), saved);
  const next = {
    licenseKey: 'NT-DEV-PASS',
    lastVerifiedAt: '2026-11-14T01:00:00.000Z',
    lastVerification: { status: 'expired', plan: '7_day_pass', validUntil: '2026-11-21T00:00:00.000Z' },
  };
  await store.save(next);
  assert.deepEqual(await createLicenseStore(createMemoryLicenseBackend(backend.current())).load(), next);
  await assert.rejects(store.save({ licenseKey: '   ' }));
});

test('verification cannot restore a removed key or replace a different current key', async () => {
  const checked = { licenseKey: 'KEY-first', lastVerification: { status: 'active', plan: 'monthly' } };
  const backend = createMemoryLicenseBackend({ licenseKey: checked.licenseKey });
  const first = createLicenseStore(backend);
  const otherPage = createLicenseStore(backend);
  assert.equal(await first.updateVerification(checked), true);
  await otherPage.remove();
  assert.equal(await first.updateVerification(checked), false);
  assert.equal(backend.current(), undefined);
  const replacement = { licenseKey: 'KEY-new', lastVerification: { status: 'active' } };
  await otherPage.save(replacement);
  assert.equal(await first.updateVerification(checked), false);
  assert.deepEqual(backend.current(), replacement);
});

test('an older request cannot overwrite newer verification of the same key', async () => {
  const current = { licenseKey: 'KEY-first', lastVerifiedAt: '2026-11-16T01:00:00.000Z',
    lastVerification: { status: 'active', validUntil: '2026-12-16T00:00:00.000Z' } };
  const store = createLicenseStore(createMemoryLicenseBackend(current));
  assert.equal(await store.updateVerification({ licenseKey: current.licenseKey,
    lastVerifiedAt: '2026-11-16T00:00:00.000Z', lastVerification: { status: 'expired' } }), false);
  assert.deepEqual(await store.load(), current);
});

test('activation rejects a stale revision after another page saves or removes a key', async () => {
  const backend = createMemoryLicenseBackend();
  const first = createLicenseStore(backend);
  const otherPage = createLicenseStore(backend);
  const beforeActivation = await first.revision();
  assert.equal(beforeActivation, null);
  await otherPage.save({ licenseKey: 'KEY-new' });
  assert.equal(await first.save({ licenseKey: 'KEY-old' }, beforeActivation), false);
  assert.equal(backend.current().licenseKey, 'KEY-new');

  await otherPage.remove();
  // Both the initial and current records are empty, but the intervening removal must still win.
  assert.equal(await first.save({ licenseKey: 'KEY-old' }, beforeActivation), false);
  assert.equal(backend.current(), undefined);
  const currentRevision = await createLicenseStore(backend).revision();
  assert.notEqual(currentRevision, beforeActivation);
  assert.equal(await first.save({ licenseKey: 'KEY-current' }, currentRevision), true);
  assert.equal(backend.current().licenseKey, 'KEY-current');
});

test('refreshing verification metadata does not invalidate a pending activation revision', async () => {
  const backend = createMemoryLicenseBackend({ licenseKey: 'KEY-first' });
  const store = createLicenseStore(backend);
  const revision = await store.revision();
  await createLicenseStore(backend).updateVerification({ licenseKey: 'KEY-first', lastVerification: { status: 'expired' } });
  assert.equal(await store.save({ licenseKey: 'KEY-new' }, revision), true);
  assert.equal(backend.current().licenseKey, 'KEY-new');
});

test('removal is serialized with the verification read and write across stores', async () => {
  const checked = { licenseKey: 'KEY-first', lastVerification: { status: 'active' } };
  const backend = createMemoryLicenseBackend({ licenseKey: checked.licenseKey });
  let enteredRead;
  let finishRead;
  const reading = new Promise(resolve => { enteredRead = resolve; });
  const waitForRead = new Promise(resolve => { finishRead = resolve; });
  const checkingPage = createLicenseStore({
    ...backend,
    async read() {
      const current = await backend.read();
      enteredRead();
      await waitForRead;
      return current;
    },
  });
  const otherPage = createLicenseStore(backend);
  const verifying = checkingPage.updateVerification(checked);
  await reading;
  const removing = otherPage.remove();
  finishRead();
  await Promise.all([verifying, removing]);
  assert.equal(backend.current(), undefined);
});

test('new access states round-trip alongside existing saved license records', async () => {
  for (const status of ['active', 'expired', 'revoked', 'invalid', 'access_revoked', 'inactive', 'none']) {
    const record = { licenseKey: 'KEY-saved', lastVerification: { status } };
    const store = createLicenseStore(createMemoryLicenseBackend(record));
    assert.deepEqual(await store.load(), record);
    await store.updateVerification(record);
    assert.deepEqual(await store.load(), record);
  }
});

test('license storage uses local extension storage and stays out of the content script', async () => {
  const chrome = await readFile(new URL('../../license/chrome.ts', import.meta.url), 'utf8');
  const keys = await readFile(new URL('../../license/keys.ts', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../../settings/keys.ts', import.meta.url), 'utf8');
  assert.match(keys, /LICENSE_STORAGE_KEY = 'license'/);
  assert.match(chrome, /LICENSE_STORAGE_KEY/);
  assert.match(chrome, /browser\.storage\.local/);
  assert.match(settings, /SETTINGS_STORAGE_KEY = 'settings'/);
  assert.doesNotMatch(chrome, /storage\.sync|localStorage|sessionStorage|fetch\(/);
  const background = await readFile(new URL('../../entrypoints/background.ts', import.meta.url), 'utf8');
  assert.match(background, /LICENSE_STORAGE_KEY/);
  assert.match(background, /storage\.local/);
  assert.doesNotMatch(background, /localStorage|storage\.sync/);
  const content = await readFile(new URL('../../entrypoints/content.ts', import.meta.url), 'utf8');
  assert.match(content, /license\/chrome-entitlement/);
  assert.doesNotMatch(content, /LICENSE_STORAGE_KEY|licenseKey|NT-DEV-|license\/verify|validate\(/);
  for (const relative of ['core/controller.ts', 'ui/overlay.ts', 'settings/store.ts', 'settings/chrome.ts']) {
    const source = await readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /license\/|LICENSE_STORAGE_KEY|licenseKey|NT-DEV-/, relative);
  }
});
