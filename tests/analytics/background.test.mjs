import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../dom-fixture.mjs';
import { harness, settings, createAnalyticsService, endpoint, waitForAbort, ANALYTICS_TIMEOUT_MS } from './fixture.mjs';

test('missing, disabled and invalid consent never generates an ID or sends requests', async t => {
  for (const consent of [undefined, null, {}, settings(false), { schemaVersion: 1, analytics: { enabled: 'yes' } }]) {
    const fixture = harness(t, { settings: consent });
    await fixture.service.start();
    assert.equal(await fixture.service.report('translation_success'), false);
    assert.equal(fixture.generated(), 0);
    assert.equal(fixture.requests.length, 0);
  }
});

test('opt-in creates one persistent UUID; 204 succeeds with the exact private contract', async t => {
  const fixture = harness(t);
  await fixture.service.start();
  await fixture.change(true);
  assert.equal(fixture.generated(), 1);
  assert.equal(fixture.requests.length, 0);
  const id = fixture.state.installId;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(await fixture.service.report('translation_success'), true);
  const { url, init, body } = fixture.requests[0];
  assert.equal(url, endpoint);
  assert.deepEqual(body, { installId: id, event: 'translation_success' });
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
});

test('concurrent events from multiple tabs share one ID, including service worker restart', async t => {
  const fixture = harness(t, { settings: settings(true) });
  const starting = fixture.service.start();
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => fixture.service.report('translation_success'))), Array(6).fill(true));
  await starting;
  assert.equal(fixture.generated(), 1);
  assert.equal(fixture.writes(), 1);
  assert.equal(new Set(fixture.requests.map(item => item.body.installId)).size, 1);
  const id = fixture.state.installId;
  fixture.service.dispose();
  const restarted = createAnalyticsService({ storage: fixture.storage, endpoint,
    randomUUID: () => { throw new Error('Restart must reuse the ID'); },
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(init.body).installId, id);
      return new Response(null, { status: 204 });
    },
  });
  t.after(() => restarted.dispose());
  await restarted.start();
  assert.equal(await restarted.report('replace_success'), true);
});

test('disable aborts an in-flight report, removes the ID and re-enable creates a new one', async t => {
  const fixture = harness(t, { settings: settings(true), fetch: waitForAbort });
  await fixture.service.start();
  const original = fixture.state.installId;
  const reporting = fixture.service.report('translation_success');
  await settle();
  await fixture.change(false);
  assert.equal(await reporting, false);
  assert.equal(fixture.requests[0].init.signal.aborted, true);
  assert.equal(fixture.state.installId, undefined);
  assert.equal(await fixture.service.report('translation_error'), false);
  assert.equal(fixture.requests.length, 1);
  await fixture.change(true);
  assert.notEqual(fixture.state.installId, original);
});

test('rapid disable and enable cannot reuse the old ID or race an in-flight ID write', async t => {
  let finishWrite;
  const fixture = harness(t, { settings: settings(true), storage: {
    writeInstallId: id => new Promise(resolve => { finishWrite = () => { fixture.state.installId = id; resolve(); }; }),
  } });
  const starting = fixture.service.start();
  await settle();
  const reporting = fixture.service.report('translation_success');
  const disabling = fixture.change(false);
  const enabling = fixture.change(true);
  const firstWrite = finishWrite;
  // Subsequent writes complete normally, after the old write and removal finish.
  fixture.storage.writeInstallId = async id => { fixture.state.installId = id; };
  firstWrite();
  await Promise.all([starting, disabling, enabling]);
  assert.equal(await reporting, false);
  await settle();
  assert.equal(fixture.generated(), 2);
  assert.equal(fixture.requests.length, 0);
  assert.equal(await fixture.service.report('replace_success'), true);
});

test('read, write, watch and UUID failures fail closed', async t => {
  for (const storage of [
    { read: async () => { throw new Error('Storage offline'); } },
    { writeInstallId: async () => { throw new Error('Quota'); } },
    { watchSettings: () => { throw new Error('Storage unavailable'); } },
  ]) {
    const fixture = harness(t, { settings: settings(true), storage });
    await fixture.service.start();
    assert.equal(await fixture.service.report('translation_success'), false);
    assert.equal(fixture.requests.length, 0);
  }
  const fixture = harness(t, { settings: settings(true) });
  const brokenId = createAnalyticsService({ storage: fixture.storage, endpoint, randomUUID: () => { throw new Error('UUID unavailable'); } });
  t.after(() => brokenId.dispose());
  await brokenId.start();
  assert.equal(await brokenId.report('translation_success'), false);
});

test('failed removal does not allow old IDs to be reused on the next enable', async t => {
  const fixture = harness(t, { settings: settings(true) });
  await fixture.service.start();
  const oldId = fixture.state.installId;
  fixture.storage.removeInstallId = async () => { throw new Error('Temporary failure'); };
  await fixture.change(false);
  assert.equal(await fixture.service.report('translation_success'), false);
  await fixture.change(true);
  assert.notEqual(fixture.state.installId, oldId);
});

test('a persisted consent change is rechecked even if the content script is stale', async t => {
  const fixture = harness(t, { settings: settings(true) });
  await fixture.service.start();
  fixture.state.settings = settings(false); // Deliberately miss the notification.
  assert.equal(await fixture.service.report('translation_success'), false);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state.installId, undefined);
});

test('a storage read failure after opt-in aborts other in-flight reports and sends no new event', async t => {
  const fixture = harness(t, { settings: settings(true), fetch: waitForAbort });
  await fixture.service.start();
  const pending = fixture.service.report('translation_success');
  await settle();
  fixture.storage.read = async () => { throw new Error('Storage temporarily unavailable'); };
  assert.equal(await fixture.service.report('replace_success'), false);
  assert.equal(await pending, false);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].init.signal.aborted, true);
});

test('HTTP errors and disconnected network are best effort with no automatic retry', async t => {
  for (const status of [200, 400, 429, 500, 503]) {
    const fixture = harness(t, { settings: settings(true), fetch: async () => new Response(null, { status }) });
    await fixture.service.start();
    assert.equal(await fixture.service.report('translation_success'), false);
    await settle();
    assert.equal(fixture.requests.length, 1);
  }
  const fixture = harness(t, { settings: settings(true), fetch: async () => { throw new TypeError('Offline'); } });
  await fixture.service.start();
  assert.equal(await fixture.service.report('translation_success'), false);
  assert.equal(fixture.requests.length, 1);
});

test('timeout aborts once and drops excess concurrency without a persistent queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = harness(t, { settings: settings(true), fetch: waitForAbort });
  await fixture.service.start();
  const reports = Array.from({ length: 10 }, () => fixture.service.report('translation_success'));
  await settle();
  assert.equal(fixture.requests.length, 8);
  t.mock.timers.tick(ANALYTICS_TIMEOUT_MS);
  assert.deepEqual(await Promise.all(reports), Array(10).fill(false));
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fixture.requests.length, 8);
});

test('missing configuration and unrecognized events send nothing', async t => {
  const fixture = harness(t, { settings: settings(true), endpoint: undefined });
  await fixture.service.start();
  assert.equal(await fixture.service.report('translation_success'), false);
  assert.equal(fixture.requests.length, 0);
  const unknown = harness(t, { settings: settings(true) });
  await unknown.service.start();
  assert.equal(await unknown.service.report('typing'), false);
  assert.equal(unknown.requests.length, 0);
});
