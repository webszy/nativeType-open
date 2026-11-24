import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../load-ts.mjs';
import { settle } from '../dom-fixture.mjs';

const { createPolishClient, PolishError } = await loadTs('ai/client.ts');
const { createPolishService } = await loadTs('ai/background.ts');
const { polishEndpoint } = await loadTs('ai/config.ts');
const input = { source_language: 'zh', target_language: 'en', original_source: '私有原文', draft: 'Private local draft' };
const result = { success: true, model: '@cf/google/gemma-4-26b-a4b-it', text: 'Improved text', elapsed_ms: 1, request_id: 'test', finish_reason: 'stop', usage: {} };
const licenseKey = 'NT-AAAA-AAAA-AAAA-AAAA-AAAA';
const activeLicense = { licenseKey, lastVerification: { status: 'active', plan: 'monthly', validUntil: null } };
const endpoint = 'https://self-test.test/api/v1/polish';
const { createLicenseStore, createMemoryLicenseBackend } = await loadTs('license/store.ts');

test('rewrite responses refresh local access on success and PLUS_REQUIRED', async () => {
  const store = createLicenseStore(createMemoryLicenseBackend(activeLicense));
  const entitlement = { status: 'active', plan: 'plus_monthly', accessUntil: '2027-01-01T00:00:00.000Z' };
  let response = () => Response.json({ ...result, entitlement });
  const service = createPolishService({ endpoint, readLicense: () => store.load(),
    updateLicenseVerification: record => store.updateVerification(record), fetch: async () => response() });
  assert.equal((await service.request('tab', 'success', input)).success, true);
  assert.deepEqual((await store.load()).lastVerification, {
    status: 'active', plan: 'monthly', validUntil: entitlement.accessUntil,
  });
  response = () => Response.json({ success: false, error: 'PLUS_REQUIRED', request_id: 'expired',
    entitlement: { ...entitlement, status: 'expired' } }, { status: 403 });
  assert.equal((await service.request('tab', 'expired', input)).error, 'PLUS_REQUIRED');
  assert.equal((await store.load()).lastVerification.status, 'expired');
});

test('old rewrite responses cannot overwrite a switched or removed license key', async () => {
  for (const remove of [false, true]) {
    const store = createLicenseStore(createMemoryLicenseBackend({ licenseKey }));
    let complete;
    const service = createPolishService({ endpoint, readLicense: async () => activeLicense,
      updateLicenseVerification: record => store.updateVerification(record),
      fetch: () => new Promise(resolve => { complete = resolve; }) });
    const pending = service.request('tab', 'pending', input);
    await settle();
    if (remove) await store.remove();
    else await store.save({ licenseKey: 'NEW-KEY' });
    complete(Response.json({ ...result, entitlement: {
      status: 'active', plan: 'plus_7_day', accessUntil: '2027-01-01T00:00:00.000Z',
    } }));
    assert.equal((await pending).success, true);
    assert.deepEqual(await store.load(), remove ? null : { licenseKey: 'NEW-KEY' });
  }
});

test('network errors and missing or malformed access metadata leave verification unchanged', async () => {
  const original = { licenseKey, lastVerification: { status: 'active', plan: 'monthly', validUntil: null } };
  const store = createLicenseStore(createMemoryLicenseBackend(original));
  for (const fetch of [
    async () => { throw new Error('offline'); },
    async () => Response.json(result),
    async () => Response.json({ ...result, entitlement: { status: 'active', plan: 'plus_monthly', accessUntil: 'bad date' } }),
    async () => Response.json({ ...result, entitlement: { status: 'expired' } }),
  ]) {
    const service = createPolishService({ endpoint, readLicense: async () => activeLicense,
      updateLicenseVerification: record => store.updateVerification(record), fetch });
    await service.request('tab', 'request', input);
    assert.deepEqual(await store.load(), original);
  }
});

test('cache write failure does not discard a successful rewrite', async () => {
  const service = createPolishService({ endpoint, readLicense: async () => activeLicense,
    updateLicenseVerification: async () => { throw new Error('storage unavailable'); },
    fetch: async () => Response.json({ ...result, entitlement: {
      status: 'active', plan: 'plus_monthly', accessUntil: null,
    } }) });
  assert.equal((await service.request('tab', 'request', input)).text, result.text);
});

test('AI endpoint configuration permits only explicit secure bases and development loopback', () => {
  assert.equal(polishEndpoint(undefined, 'production'), undefined);
  for (const url of ['https://user:secret@example.com', 'https://example.com?secret=1', 'https://example.com/#fragment', 'http://example.com']) {
    assert.equal(polishEndpoint(url, 'development'), undefined);
  }
  assert.equal(polishEndpoint('http://localhost:8787/api/', 'development'), 'http://localhost:8787/api/v1/polish');
  assert.equal(polishEndpoint('http://localhost:8787/api', 'production'), undefined);
  assert.equal(polishEndpoint('https://self-test.test/api/', 'production'), endpoint);
  const override = 'https://rewrite.test/custom/path/';
  assert.equal(polishEndpoint('https://self-test.test/api', 'production', override), override);
  assert.equal(polishEndpoint('https://self-test.test/api', 'production', 'http://rewrite.test'), undefined);
});

test('client sends only the four requested fields after manual invocation and cancellation uses the matching id', async () => {
  let finish;
  const messages = [];
  const client = createPolishClient(message => { messages.push(message); return new Promise(resolve => { finish = resolve; }); });
  assert.deepEqual(messages, []);
  const abort = new AbortController();
  const pending = client(input, abort.signal);
  await settle();
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].input, input);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  abort.abort(); await rejected;
  assert.equal(messages[1].type, 'ai:cancel');
  assert.equal(messages[1].requestId, messages[0].requestId);
  finish?.(result);
});

test('client returns safe errors and never surfaces provider debug messages', async () => {
  const client = createPolishClient(async () => { throw new Error(input.original_source); });
  await assert.rejects(client(input, new AbortController().signal), error => error instanceof PolishError && !error.message.includes(input.original_source));
});

test('background fails closed without endpoint or license key and does not upload drafts', async () => {
  let calls = 0;
  const service = createPolishService({ endpoint, readLicense: async () => undefined, fetch: async () => { calls += 1; } });
  assert.equal((await service.request('tab', 'id', input)).error, 'UNAUTHORIZED');
  const disabled = createPolishService({ endpoint: undefined, readLicense: async () => activeLicense, fetch: async () => { calls += 1; } });
  assert.equal((await disabled.request('tab', 'id', input)).error, 'MODEL_ERROR');
  assert.equal(calls, 0);
});

test('background blocks missing, unverified, expired and revoked access without uploading any text', async () => {
  let uploads = 0;
  for (const license of [null, { licenseKey },
    ...['expired', 'revoked', 'access_revoked', 'invalid', 'inactive', 'none'].map(status => ({ ...activeLicense, lastVerification: { ...activeLicense.lastVerification, status } })),
    { ...activeLicense, lastVerification: { status: 'active', plan: 'monthly', validUntil: '2000-01-01T00:00:00Z' } },
    { ...activeLicense, lastVerification: { status: 'active', plan: 'monthly', validUntil: 'bad-date' } },
    { ...activeLicense, lastVerification: { status: 'active', plan: 'monthly' } },
    { ...activeLicense, lastVerification: { status: 'active', validUntil: null } },
  ]) {
    const service = createPolishService({ endpoint, readLicense: async () => license,
      fetch: async () => { uploads++; return Response.json(result); } });
    const reply = await service.request('tab', 'id', input);
    assert.equal(reply.error, license ? 'PLUS_REQUIRED' : 'UNAUTHORIZED');
  }
  assert.equal(uploads, 0);
});

test('every Retry reads current access, and activation enables only a later explicit request', async () => {
  let license = { licenseKey };
  let uploads = 0;
  const service = createPolishService({ endpoint, readLicense: async () => license,
    fetch: async () => { uploads++; return Response.json(result); } });
  assert.equal((await service.request('tab', 'free', input)).error, 'PLUS_REQUIRED');
  license = activeLicense;
  assert.equal(uploads, 0);
  assert.equal((await service.request('tab', 'active', input)).success, true);
  license = { ...activeLicense, lastVerification: { status: 'revoked' } };
  assert.equal((await service.request('tab', 'revoked', input)).error, 'PLUS_REQUIRED');
  assert.equal(uploads, 1);
});

test('background shares per-context draft limits and allows longer original text without truncation', async () => {
  for (const [writing_context, limit] of [['reply', 280], ['quote', 280], ['post', 4000], ['chat', 4000], [undefined, 280]]) {
    const uploads = [];
    const service = createPolishService({ endpoint, readLicense: async () => activeLicense,
      fetch: async (_url, init) => { uploads.push(JSON.parse(init.body)); return Response.json(result); } });
    const valid = { ...input, original_source: '原'.repeat(4500), draft: 'a'.repeat(limit),
      ...(writing_context ? { writing_context } : {}) };
    assert.equal((await service.request('tab', 'valid', valid)).success, true);
    assert.deepEqual(uploads[0], valid);
    assert.equal((await service.request('tab', 'long', { ...valid, draft: 'a'.repeat(limit + 1) })).error, 'INVALID_REQUEST');
    assert.equal(uploads.length, 1);
  }
});

test('background sends only original and local text plus language pair, omits cookies, and does not retry', async () => {
  const calls = [];
  const service = createPolishService({ endpoint, readLicense: async () => activeLicense, fetch: async (...args) => { calls.push(args); return Response.json(result); } });
  assert.deepEqual(await service.request('tab', 'id', input), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], endpoint);
  const init = calls[0][1];
  assert.deepEqual(JSON.parse(init.body), input);
  assert.equal(init.headers['x-nativetype-license'], licenseKey);
  assert.equal(init.headers.authorization, undefined);
  for (const [key, value] of Object.entries({ credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })) assert.equal(init[key], value);
});

test('cancellation is scoped to its sender and request, including while credentials are being read', async () => {
  let read;
  let calls = 0;
  const service = createPolishService({ endpoint, readLicense: () => new Promise(resolve => { read = resolve; }), fetch: async () => { calls += 1; return Response.json(result); } });
  const pending = service.request('owner-a', 'id-a', input);
  service.cancel('owner-b', 'id-a');
  service.cancel('owner-a', 'old-id');
  service.cancel('owner-a', 'id-a');
  read(activeLicense);
  assert.equal((await pending).error, 'TIMEOUT');
  assert.equal(calls, 0);
});

test('new requests abort old fetches and old cancellation cannot cancel the new request', async () => {
  const signals = [];
  const service = createPolishService({ endpoint, readLicense: async () => activeLicense, fetch: async (_url, init) => {
    signals.push(init.signal);
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      if (signals.length === 2) resolve(Response.json(result));
    });
  } });
  const old = service.request('tab', 'old', input); await settle();
  const next = service.request('tab', 'next', input); await settle();
  service.cancel('tab', 'old');
  assert.equal((await old).error, 'TIMEOUT');
  assert.deepEqual(await next, result);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
});

test('network errors, malformed payloads and oversized model replies fail without automatic retry', async () => {
  for (const response of [() => { throw new Error('Provider private debug'); }, () => new Response('not json'),
    () => Response.json({ ...result, text: '' }), () => Response.json({ ...result, text: 'x'.repeat(100_000) })]) {
    let calls = 0;
    const service = createPolishService({ endpoint, readLicense: async () => activeLicense, fetch: async () => { calls += 1; return response(); } });
    const reply = await service.request('tab', 'id', input);
    assert.equal(reply.error, 'MODEL_ERROR');
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(reply).includes('private'));
  }
});

test('background timeout completes even when transport never resolves or honors abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createPolishService({ endpoint, readLicense: async () => activeLicense, fetch: () => new Promise(() => {}) });
  const pending = service.request('owner', 'id', input);
  await settle(); t.mock.timers.tick(30_000); await settle();
  assert.equal((await pending).error, 'TIMEOUT');
});

test('content timeout restores the flow even when the extension message channel never replies', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const messages = [];
  const client = createPolishClient(message => { messages.push(message); return new Promise(() => {}); });
  const pending = client(input, new AbortController().signal);
  const rejected = assert.rejects(pending, error => error instanceof PolishError && error.code === 'TIMEOUT');
  await settle(); t.mock.timers.tick(31_000); await rejected;
  assert.equal(messages.filter(message => message.type === 'ai:polish').length, 1);
  assert.equal(messages[1].type, 'ai:cancel');
});
