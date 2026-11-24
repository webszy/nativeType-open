import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../load-ts.mjs';

const { entitlementBadge, createEntitlementBadgeSource, hasActivePlusLicense } = await loadTs('license/entitlement.ts');

test('upload eligibility requires a recognized plan and unexpired complete verification', t => {
  const now = new Date('2026-11-16T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const plan of ['monthly', '7_day_pass']) {
    const record = validUntil => ({ licenseKey: 'NT-saved', lastVerification: { status: 'active', plan, validUntil } });
    assert.equal(hasActivePlusLicense(record(new Date(+now + 1).toISOString())), true);
    assert.equal(hasActivePlusLicense(record(now.toISOString())), false);
    assert.equal(hasActivePlusLicense(record(new Date(+now - 1).toISOString())), false);
    assert.equal(hasActivePlusLicense(record('bad-date')), false);
    assert.equal(hasActivePlusLicense(record(undefined)), false);
    assert.equal(hasActivePlusLicense(record(null)), true);
  }
  for (const lastVerification of [{ status: 'active', validUntil: null }, { status: 'active', plan: 'free', validUntil: null },
    { status: 'expired', plan: 'monthly', validUntil: null }]) {
    assert.equal(hasActivePlusLicense({ licenseKey: 'NT-saved', lastVerification }), false);
  }
  assert.equal(hasActivePlusLicense(null), false);
});

test('stored license status maps to Plus, Free, or unknown without reading a key back', () => {
  assert.equal(entitlementBadge(null), 'free');
  assert.equal(entitlementBadge({}), 'free');
  assert.equal(entitlementBadge({ licenseKey: '   ' }), 'free');
  assert.equal(entitlementBadge({ licenseKey: 'NT-saved' }), 'unknown');
  assert.equal(entitlementBadge({ licenseKey: 'NT-saved', lastVerification: { status: 'nope' } }), 'unknown');
  assert.equal(entitlementBadge({ licenseKey: 'NT-saved', lastVerification: { status: 'active' } }), 'plus');
  assert.equal(entitlementBadge({ licenseKey: 'NT-saved', lastVerification: { status: 'active', plan: 'monthly' } }), 'plus');
  assert.equal(entitlementBadge({ licenseKey: 'NT-saved', lastVerification: { status: 'active', plan: '7_day_pass' } }), 'plus');
  for (const status of ['expired', 'revoked', 'invalid', 'access_revoked', 'inactive', 'none']) {
    assert.equal(entitlementBadge({ licenseKey: 'NT-saved', lastVerification: { status } }), 'free', status);
  }
});

test('the badge source reads stored status once and follows storage changes', async () => {
  let current = { licenseKey: 'NT-saved' };
  let fail = false;
  const listeners = new Set();
  const source = createEntitlementBadgeSource({
    async read() {
      if (fail) throw new Error('storage unavailable');
      return current;
    },
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  assert.equal(await source.load(), 'unknown');
  const seen = [];
  const stop = source.subscribe(badge => seen.push(badge));
  current = { licenseKey: 'NT-saved', lastVerification: { status: 'active', plan: '7_day_pass' } };
  for (const listener of listeners) listener(current);
  current = undefined;
  for (const listener of listeners) listener(current);
  fail = true;
  assert.equal(await source.load(), 'unknown');
  stop();
  assert.deepEqual(seen, ['plus', 'free']);
  assert.equal(listeners.size, 0);
});

test('active verification stops claiming Plus at its expiration boundary', t => {
  const now = new Date('2026-11-16T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const record = validUntil => ({ licenseKey: 'NT-saved', lastVerification: { status: 'active', validUntil } });
  assert.equal(entitlementBadge(record(new Date(+now + 1).toISOString())), 'plus');
  assert.equal(entitlementBadge(record(now.toISOString())), 'unknown');
  assert.equal(entitlementBadge(record(new Date(+now - 1).toISOString())), 'unknown');
  assert.equal(entitlementBadge(record('invalid date')), 'unknown');
  assert.equal(entitlementBadge(record(null)), 'plus');
});

test('open-page badges expire, reschedule on renewal, and stop after unsubscribe', async t => {
  const now = new Date('2026-11-16T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const record = delay => ({ licenseKey: 'NT-saved', lastVerification: {
    status: 'active', validUntil: new Date(+now + delay).toISOString(),
  } });
  let changed;
  const source = createEntitlementBadgeSource({
    read: async () => record(1000),
    watch(listener) { changed = listener; return () => { changed = undefined; }; },
  });
  const seen = [];
  const stop = source.subscribe(value => seen.push(value));
  await Promise.resolve();
  assert.deepEqual(seen, ['plus']);
  changed(record(2000));
  t.mock.timers.tick(1000);
  assert.deepEqual(seen, ['plus', 'plus']);
  t.mock.timers.tick(1000);
  assert.deepEqual(seen, ['plus', 'plus', 'unknown']);
  changed(record(3000));
  stop();
  t.mock.timers.tick(1000);
  assert.deepEqual(seen, ['plus', 'plus', 'unknown', 'plus']);
  assert.equal(changed, undefined);
});

test('a late initial read cannot replace a new license or its expiration timer', async t => {
  const now = new Date('2026-11-16T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  let resolveRead;
  let changed;
  const source = createEntitlementBadgeSource({
    read: () => new Promise(resolve => { resolveRead = resolve; }),
    watch(listener) { changed = listener; return () => {}; },
  });
  const seen = [];
  const stop = source.subscribe(value => seen.push(value));
  changed({ licenseKey: 'NT-new', lastVerification: {
    status: 'active', validUntil: new Date(+now + 1000).toISOString(),
  } });
  resolveRead(null);
  await Promise.resolve();
  assert.deepEqual(seen, ['plus']);
  t.mock.timers.tick(1000);
  assert.deepEqual(seen, ['plus', 'unknown']);
  stop();
});

test('expiration delays beyond the timer limit do not expire early', async t => {
  const now = new Date('2026-11-16T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const delay = 30 * 24 * 60 * 60 * 1000;
  const source = createEntitlementBadgeSource({
    read: async () => ({ licenseKey: 'NT-saved', lastVerification: {
      status: 'active', validUntil: new Date(+now + delay).toISOString(),
    } }),
    watch: () => () => {},
  });
  const seen = [];
  const stop = source.subscribe(value => seen.push(value));
  await Promise.resolve();
  t.mock.timers.tick(2_147_483_647);
  assert.equal(seen.at(-1), 'plus');
  t.mock.timers.tick(delay - 2_147_483_647);
  assert.equal(seen.at(-1), 'unknown');
  stop();
});
