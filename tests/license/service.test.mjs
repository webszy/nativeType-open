import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { settle } from '../dom-fixture.mjs';
import { loadTs } from '../load-ts.mjs';

const {
  createLicenseService, createProductionLicenseService, licenseVerificationTimeoutMs,
  licenseVerifyEndpoint, LicenseVerificationError,
} = await loadTs('license/service.ts');

test('the production environment configures the license verification endpoint', async () => {
  const production = await readFile(new URL('../../.env.production', import.meta.url), 'utf8');
  const base = production.match(/^WXT_POLISH_API_BASE_URL=(.+)$/m)?.[1].trim();
  assert.equal(licenseVerifyEndpoint(base, 'production'), 'https://nativetype.here/api/v1/license/verify');
});

test('development mock covers the license outcomes and does not activate arbitrary keys', async () => {
  const service = await createLicenseService();
  assert.deepEqual(await service.validate('  NT-DEV-MONTHLY  '), {
    status: 'active', plan: 'monthly', validUntil: '2026-12-14T00:00:00.000Z',
  });
  assert.deepEqual(await service.validate('NT-DEV-PASS'), {
    status: 'active', plan: '7_day_pass', validUntil: '2026-11-21T00:00:00.000Z',
  });
  assert.deepEqual(await service.validate('NT-DEV-OPEN'), {
    status: 'active', plan: 'monthly', validUntil: null,
  });
  assert.deepEqual(await service.validate('NT-DEV-INVALID'), { status: 'invalid' });
  assert.deepEqual(await service.validate('not-a-real-key'), { status: 'invalid' });
  assert.equal((await service.validate('NT-DEV-EXPIRED')).status, 'expired');
  assert.equal((await service.validate('NT-DEV-REVOKED')).status, 'revoked');
  await assert.rejects(service.validate('NT-DEV-NETWORK'), error =>
    error instanceof LicenseVerificationError && error.code === 'network_error' && !error.message.includes('NT-DEV-NETWORK'));
});

test('production verification maps Plus, expiry, revocation and network failures', async () => {
  const calls = [];
  const service = createProductionLicenseService({
    endpoint: 'https://typewith.si/api/v1/license/verify',
    fetch: async (url, init) => {
      calls.push({ url, init });
      const key = init.headers['x-nativetype-license'];
      if (key === 'NT-DEV-MONTHLY') return Response.json({ keyValid: true, isPlus: true, plan: 'plus_monthly', status: 'active', accessUntil: '2026-12-14T00:00:00.000Z' });
      if (key === 'NT-DEV-EXPIRED') return Response.json({ keyValid: true, isPlus: false, plan: 'plus_7_day', status: 'expired', accessUntil: '2026-11-21T00:00:00.000Z' });
      if (key === 'NT-DEV-REVOKED') return Response.json({ keyValid: false, isPlus: false, plan: null, status: 'revoked', accessUntil: null });
      if (key === 'NT-DEV-NETWORK') return new Response('unavailable', { status: 503 });
      return Response.json({ keyValid: false, isPlus: false, plan: null, status: 'invalid', accessUntil: null }, { status: 401 });
    },
  });
  assert.deepEqual(await service.validate(' NT-DEV-MONTHLY '), {
    status: 'active', plan: 'monthly', validUntil: '2026-12-14T00:00:00.000Z',
  });
  assert.equal((await service.validate('NT-DEV-EXPIRED')).status, 'expired');
  assert.equal((await service.validate('NT-DEV-REVOKED')).status, 'revoked');
  assert.equal((await service.validate('NT-DEV-INVALID')).status, 'invalid');
  await assert.rejects(service.validate('NT-DEV-NETWORK'), error => error instanceof LicenseVerificationError);
  assert.equal(calls[0].url, 'https://typewith.si/api/v1/license/verify');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(new URL(calls[0].url).search, '');
});

test('valid keys preserve revoked, inactive and missing Plus access separately from key revocation', async () => {
  for (const [serverStatus, expectedStatus] of [
    ['revoked', 'access_revoked'],
    ['inactive', 'inactive'],
    ['none', 'none'],
  ]) {
    const service = createProductionLicenseService({
      endpoint: 'https://typewith.si/api/v1/license/verify',
      fetch: async () => Response.json({
        keyValid: true, isPlus: false, status: serverStatus,
        plan: serverStatus === 'none' ? null : 'plus_monthly', accessUntil: null,
      }),
    });
    const info = await service.validate('NT-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA');
    assert.equal(info.status, expectedStatus);
    assert.equal(info.validUntil, null);
    assert.equal(info.plan, serverStatus === 'none' ? undefined : 'monthly');
  }
  const revoked = createProductionLicenseService({
    endpoint: 'https://typewith.si/api/v1/license/verify',
    fetch: async () => Response.json({
      keyValid: false, isPlus: false, status: 'revoked', plan: null, accessUntil: null,
    }, { status: 401 }),
  });
  assert.deepEqual(await revoked.validate('NT-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA'), { status: 'revoked' });
});

test('verification times out even when transport ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const service = createProductionLicenseService({
    endpoint: 'https://typewith.si/api/v1/license/verify',
    fetch: (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    },
  });
  const rejected = assert.rejects(
    service.validate('NT-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA'),
    error => error instanceof LicenseVerificationError,
  );
  await settle();
  t.mock.timers.tick(licenseVerificationTimeoutMs);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('the verification deadline also bounds an unfinished response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stream;
  const response = new Response(new ReadableStream({
    start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode('{"keyValid":'));
    },
  }));
  const service = createProductionLicenseService({
    endpoint: 'https://typewith.si/api/v1/license/verify',
    fetch: async () => response,
  });
  try {
    const rejected = assert.rejects(
      service.validate('NT-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA'),
      error => error instanceof LicenseVerificationError,
    );
    await settle();
    t.mock.timers.tick(licenseVerificationTimeoutMs);
    await rejected;
  } finally {
    stream.close();
  }
});

test('production verification canonicalizes both key lengths and rejects an invalid length', async () => {
  const fresh = 'NT-0123-4567-89AB-CDEF-GHJK';
  const legacy = 'NT-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA';
  const calls = [];
  const service = createProductionLicenseService({
    endpoint: 'https://typewith.si/api/v1/license/verify',
    fetch: async (_url, init) => {
      calls.push(init.headers['x-nativetype-license']);
      return Response.json({ keyValid: true, isPlus: true, plan: 'plus_monthly', status: 'active', accessUntil: '2026-12-14T00:00:00.000Z' });
    },
  });
  assert.equal((await service.validate(` ${fresh.toLowerCase()} `)).status, 'active');
  assert.equal((await service.validate(legacy.toLowerCase())).status, 'active');
  assert.deepEqual(calls, [fresh, legacy]);
  assert.deepEqual(await service.validate('NT-1234'), { status: 'invalid' });
  assert.deepEqual(await service.validate(`NT-${'A'.repeat(90)}`), { status: 'invalid' });
  assert.deepEqual(calls, [fresh, legacy]);
});

test('production verification fails closed for every key, including mock keys', async () => {
  const production = createProductionLicenseService();
  for (const key of ['NT-DEV-MONTHLY', 'NT-DEV-PASS', 'NT-DEV-OPEN', 'anything']) {
    await assert.rejects(production.validate(key), error =>
      error instanceof LicenseVerificationError && !error.message.includes(key));
  }
  const previous = globalThis.__nativetypeTestEnv;
  globalThis.__nativetypeTestEnv = { MODE: 'production' };
  try {
    const service = await createLicenseService();
    await assert.rejects(service.validate('NT-DEV-MONTHLY'), error => error instanceof LicenseVerificationError);
  } finally {
    if (previous === undefined) delete globalThis.__nativetypeTestEnv;
    else globalThis.__nativetypeTestEnv = previous;
  }
});

test('mock keys and license requests stay behind the service boundary', async () => {
  const service = await readFile(new URL('../../license/service.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../../license/page.ts', import.meta.url), 'utf8');
  assert.match(service, /import\.meta\.env\.MODE !== 'production'/);
  assert.match(service, /import\('\.\/mock'\)/);
  assert.doesNotMatch(service, /NT-DEV-/);
  assert.doesNotMatch(page, /NT-DEV-|fetch\(|XMLHttpRequest|console\.|localStorage|storage\.sync/);
});
