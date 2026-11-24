import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, settle } from '../dom-fixture.mjs';
import { loadTs } from '../load-ts.mjs';

const { mountPlusPanel } = await loadTs('license/page.ts');
const { createLicenseStore, createMemoryLicenseBackend } = await loadTs('license/store.ts');
const { createProductionLicenseService, licenseVerificationTimeoutMs } = await loadTs('license/service.ts');

function byId(root, id) {
  return [...root.querySelectorAll('*')].find(element => element.id === id);
}

function deferredService() {
  const calls = [];
  let pending;
  return {
    calls,
    validate(key) {
      calls.push(key);
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    },
    finish(value) { pending.resolve(value); },
    fail(error = new Error('offline')) { pending.reject(error); },
  };
}

async function mount(t, service, initial) {
  const { document } = installDOM(t);
  const backend = createMemoryLicenseBackend(initial);
  const store = createLicenseStore(backend);
  const root = document.createElement('section');
  document.body.append(root);
  const mounted = mountPlusPanel(root, { service, store });
  return { root, backend, store, mounted, document };
}

const monthly = { status: 'active', plan: 'monthly', validUntil: '2026-12-14T00:00:00.000Z' };
const pass = { status: 'active', plan: '7_day_pass', validUntil: '2026-11-21T00:00:00.000Z' };

test('an empty license cannot be submitted and a pasted key can activate', async t => {
  const service = deferredService();
  const view = await mount(t, service);
  await view.mounted;
  const input = byId(view.root, 'license-key');
  assert.equal(input.placeholder, 'NT-XXXX-XXXX-XXXX-XXXX-XXXX');
  assert.equal(input.className, 'license-key-input');
  const activate = byId(view.root, 'activate-plus');
  const purchase = byId(view.root, 'plus-purchase');
  assert.equal(byId(view.root, 'plus-badge').textContent, 'Not Activated');
  assert.equal(byId(view.root, 'plus-subtitle').textContent, 'Express yourself better with AI.');
  assert.equal(activate.disabled, true);
  input.value = '   ';
  await input.fire('input');
  assert.equal(activate.disabled, true);
  await activate.fire('click');
  assert.deepEqual(service.calls, []);
  input.value = '  NT-DEV-MONTHLY  ';
  await input.fire('input');
  assert.equal(activate.disabled, false);
  const first = activate.fire('click');
  const second = activate.fire('click');
  assert.deepEqual(service.calls, ['NT-DEV-MONTHLY']);
  assert.equal(activate.textContent, 'Verifying');
  assert.equal(view.root.dataset.state, 'verifying');
  assert.equal(activate.disabled, true);
  service.finish(monthly);
  await first;
  await second;
  assert.equal(service.calls.length, 1);
  assert.equal(view.root.dataset.state, 'active');
  assert.equal(byId(view.root, 'plus-badge').textContent, 'Active');
  assert.equal(byId(view.root, 'plus-subtitle').textContent, 'Your Plus features are unlocked.');
  assert.equal(byId(view.root, 'plus-form').hidden, true);
  assert.equal(byId(view.root, 'plus-key-value').textContent, '•••• •••• THLY');
  assert.equal(byId(view.root, 'plus-plan-value').textContent, 'Plus Monthly');
  assert.equal(byId(view.root, 'plus-until-value').textContent, 'Dec 14, 2026');
  assert.equal(byId(view.root, 'plus-status-value').textContent, 'Active');
  assert.equal(view.root.textContent.includes('NT-DEV-MONTHLY'), false);
  assert.equal(input.value, '');
  assert.equal(purchase.getAttribute('href'), 'https://typewith.si/pricing');
  assert.equal(purchase.target, '_blank');
  assert.equal(view.backend.current().licenseKey, 'NT-DEV-MONTHLY');
  assert.equal([...view.root.querySelectorAll('a')].some(link => /manage/i.test(link.textContent)), false);
});

test('remove deletes only the saved key and the same key can be entered again', async t => {
  const service = deferredService();
  const view = await mount(t, service);
  await view.mounted;
  const input = byId(view.root, 'license-key');
  const activate = byId(view.root, 'activate-plus');
  input.value = 'NT-DEV-PASS';
  await input.fire('input');
  const activating = activate.fire('click');
  service.finish(pass);
  await activating;
  assert.equal(byId(view.root, 'plus-plan-value').textContent, '7-Day Pass');
  assert.equal(byId(view.root, 'plus-until-value').textContent, 'Nov 21, 2026');
  await byId(view.root, 'remove-license').fire('click');
  assert.equal(view.backend.current(), undefined);
  assert.equal(view.root.dataset.state, 'free');
  assert.equal(byId(view.root, 'plus-form').hidden, false);
  input.value = 'NT-DEV-PASS';
  await input.fire('input');
  const again = activate.fire('click');
  service.finish(pass);
  await again;
  assert.equal(view.backend.current().licenseKey, 'NT-DEV-PASS');
  assert.equal(view.root.dataset.state, 'active');
  assert.equal(view.root.textContent.includes('NT-DEV-PASS'), false);
});

test('a valid expired key is saved and an invalid or revoked key is not', async t => {
  const service = deferredService();
  const view = await mount(t, service);
  await view.mounted;
  const input = byId(view.root, 'license-key');
  const activate = byId(view.root, 'activate-plus');
  input.value = 'NT-DEV-INVALID';
  await input.fire('input');
  const invalid = activate.fire('click');
  service.finish({ status: 'invalid' });
  await invalid;
  assert.equal(byId(view.root, 'plus-error').textContent, 'Invalid license key. Please check and try again.');
  assert.equal(view.backend.current(), undefined);
  assert.equal(view.root.dataset.state, 'invalid');
  input.value = 'NT-DEV-EXPIRED';
  await input.fire('input');
  const expired = activate.fire('click');
  service.finish({ status: 'expired', plan: 'monthly', validUntil: '2026-01-01T00:00:00.000Z' });
  await expired;
  assert.equal(view.root.dataset.state, 'expired');
  assert.equal(byId(view.root, 'plus-status-value').textContent, 'Expired');
  assert.equal(byId(view.root, 'plus-plan-value').textContent, 'Plus Monthly');
  assert.equal(byId(view.root, 'plus-until-value').textContent, 'Jan 1, 2026');
  assert.equal(view.backend.current().licenseKey, 'NT-DEV-EXPIRED');
  assert.equal(view.root.textContent.includes('NT-DEV-EXPIRED'), false);
});

test('opening settings rechecks a saved key and does not treat the cache as active', async t => {
  const service = deferredService();
  const cached = {
    licenseKey: 'NT-DEV-MONTHLY',
    lastVerifiedAt: '2026-11-01T00:00:00.000Z',
    lastVerification: { status: 'active', plan: 'monthly', validUntil: '2026-12-14T00:00:00.000Z' },
  };
  const view = await mount(t, service, cached);
  await settle();
  assert.equal(view.root.dataset.state, 'verifying');
  assert.equal(byId(view.root, 'plus-message').textContent, 'Verifying');
  assert.equal(byId(view.root, 'plus-badge').hidden, true);
  assert.equal(byId(view.root, 'plus-subtitle').textContent, 'Express yourself better with AI.');
  assert.equal(byId(view.root, 'plus-details').hidden, true);
  service.fail();
  await view.mounted;
  assert.equal(byId(view.root, 'plus-message').textContent, 'Unable to verify your license. Please try again.');
  assert.equal(view.root.dataset.state, 'network_error');
  assert.equal(byId(view.root, 'plus-badge').hidden, true);
  assert.deepEqual(view.backend.current(), cached);
  const retry = byId(view.root, 'refresh-license').fire('click');
  await settle();
  assert.equal(byId(view.root, 'plus-message').textContent, 'Verifying');
  service.finish(monthly);
  await retry;
  assert.equal(view.root.dataset.state, 'active');
  assert.equal(view.backend.current().licenseKey, 'NT-DEV-MONTHLY');
  assert.equal(view.backend.current().lastVerification.status, 'active');
});

test('a late verification leaves a key removed in another page deleted', async t => {
  const service = deferredService();
  const view = await mount(t, service, { licenseKey: 'KEY-old' });
  await settle();
  await createLicenseStore(view.backend).remove();
  service.finish(monthly);
  await view.mounted;
  assert.equal(view.backend.current(), undefined);
  assert.equal(view.root.dataset.state, 'free');
  assert.equal(byId(view.root, 'plus-form').hidden, false);
});

test('a late verification keeps another page’s replacement and verifies that key instead', async t => {
  const service = deferredService();
  const view = await mount(t, service, { licenseKey: 'KEY-old' });
  await settle();
  await createLicenseStore(view.backend).save({ licenseKey: 'KEY-new' });
  service.finish({ status: 'revoked' });
  await settle();
  assert.equal(view.backend.current().licenseKey, 'KEY-new');
  assert.deepEqual(service.calls, ['KEY-old', 'KEY-new']);
  service.finish(monthly);
  await view.mounted;
  assert.equal(view.backend.current().licenseKey, 'KEY-new');
  assert.equal(view.root.dataset.state, 'active');
});

test('a late activation keeps a newer key activated in another page', async t => {
  const service = deferredService();
  const view = await mount(t, service);
  await view.mounted;
  const otherRoot = view.document.createElement('section');
  view.document.body.append(otherRoot);
  await mountPlusPanel(otherRoot, {
    store: createLicenseStore(view.backend),
    service: { validate: async () => monthly },
  });
  const oldKey = 'NT-AAAA-AAAA-AAAA-AAAA-AAAA';
  const newKey = 'NT-BBBB-BBBB-BBBB-BBBB-BBBB';
  byId(view.root, 'license-key').value = oldKey;
  await byId(view.root, 'license-key').fire('input');
  const pending = byId(view.root, 'activate-plus').fire('click');
  byId(otherRoot, 'license-key').value = newKey;
  await byId(otherRoot, 'license-key').fire('input');
  await byId(otherRoot, 'activate-plus').fire('click');
  assert.equal(view.backend.current().licenseKey, newKey);

  service.finish(monthly);
  await settle();
  assert.deepEqual(service.calls, [oldKey, newKey]);
  assert.equal(view.backend.current().licenseKey, newKey);
  service.finish(monthly);
  await pending;
  assert.equal(view.backend.current().licenseKey, newKey);
  assert.equal(byId(view.root, 'plus-key-value').textContent, '•••• •••• BBBB');
  assert.equal(view.root.dataset.state, 'active');
});

test('a late activation cannot restore a key removed in another page', async t => {
  const service = deferredService();
  const view = await mount(t, service);
  await view.mounted;
  byId(view.root, 'license-key').value = 'NT-AAAA-AAAA-AAAA-AAAA-AAAA';
  await byId(view.root, 'license-key').fire('input');
  const pending = byId(view.root, 'activate-plus').fire('click');
  const otherPage = createLicenseStore(view.backend);
  await otherPage.save({ licenseKey: 'KEY-new' });
  await otherPage.remove();
  service.finish(monthly);
  await pending;
  assert.equal(view.backend.current(), undefined);
  assert.equal(view.root.dataset.state, 'free');
  assert.equal(byId(view.root, 'plus-form').hidden, false);
});

test('valid keys with revoked, inactive or missing Plus access are saved with the correct message', async t => {
  const service = deferredService();
  const view = await mount(t, service);
  await view.mounted;
  for (const [status, label, message] of [
    ['access_revoked', 'Plus Access Revoked', 'Your Plus access has been revoked.'],
    ['inactive', 'Inactive', 'Your Plus access is currently inactive.'],
    ['none', 'No Plus Access', 'This license key has no Plus access.'],
  ]) {
    const input = byId(view.root, 'license-key');
    input.value = 'KEY-valid';
    await input.fire('input');
    const activating = byId(view.root, 'activate-plus').fire('click');
    service.finish({ status });
    await activating;
    assert.equal(view.root.dataset.state, status);
    assert.equal(byId(view.root, 'plus-status-value').textContent, label);
    assert.equal(byId(view.root, 'plus-message').textContent, message);
    assert.equal(view.backend.current().licenseKey, 'KEY-valid');
    assert.equal(view.backend.current().lastVerification.status, status);
    await byId(view.root, 'remove-license').fire('click');
  }
});

test('verification timeout restores the activation form and saved-key recovery actions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createProductionLicenseService({
    endpoint: 'https://typewith.si/api/v1/license/verify',
    fetch: () => new Promise(() => {}),
  });
  const first = await mount(t, service);
  await first.mounted;
  const input = byId(first.root, 'license-key');
  input.value = 'KEY-first';
  await input.fire('input');
  const activating = byId(first.root, 'activate-plus').fire('click');
  t.mock.timers.tick(licenseVerificationTimeoutMs);
  await activating;
  assert.equal(input.disabled, false);
  assert.equal(byId(first.root, 'activate-plus').disabled, false);
  assert.equal(byId(first.root, 'plus-error').hidden, false);
  assert.equal(first.backend.current(), undefined);

  const saved = { licenseKey: 'KEY-saved', lastVerification: { status: 'active' } };
  const existing = await mount(t, service, saved);
  await settle();
  t.mock.timers.tick(licenseVerificationTimeoutMs);
  await existing.mounted;
  assert.equal(existing.root.dataset.state, 'network_error');
  assert.equal(byId(existing.root, 'refresh-license').hidden, false);
  assert.equal(byId(existing.root, 'remove-license').hidden, false);
  assert.deepEqual(existing.backend.current(), saved);
});

test('stored invalid, expired, and revoked results show their own recovery actions', async t => {
  for (const [status, message] of [
    ['invalid', 'Invalid license key. Please check and try again.'],
    ['expired', 'Your Plus access has expired.'],
    ['revoked', 'This license has been revoked.'],
  ]) {
    const service = deferredService();
    const view = await mount(t, service, { licenseKey: `KEY-${status}`, lastVerification: { status } });
    const pending = view.mounted;
    await settle();
    service.finish({ status });
    await pending;
    assert.equal(byId(view.root, 'plus-message').hidden, status === 'expired');
    if (status !== 'expired') assert.equal(byId(view.root, 'plus-message').textContent, message);
    assert.equal(byId(view.root, 'plus-status-value').textContent, status === 'expired' ? 'Expired' : status === 'revoked' ? 'Revoked' : 'Invalid');
    assert.equal(byId(view.root, 'refresh-license').hidden, false);
    assert.equal(byId(view.root, 'remove-license').hidden, false);
    assert.equal(byId(view.root, 'plus-form').hidden, true);
    assert.equal(view.root.textContent.includes(`KEY-${status}`), false);
  }
});

test('an active license without an expiry hides Valid Until', async t => {
  const service = deferredService();
  const view = await mount(t, service, { licenseKey: 'NT-DEV-OPEN' });
  const pending = view.mounted;
  await settle();
  service.finish({ status: 'active', plan: 'monthly', validUntil: null });
  await pending;
  assert.equal(byId(view.root, 'plus-until-row').hidden, true);
  assert.equal(byId(view.root, 'plus-plan-value').textContent, 'Plus Monthly');
});

test('new and legacy keys activate, and an invalid length does not replace storage', async t => {
  const fresh = 'NT-0123-4567-89AB-CDEF-GHJK';
  const legacy = 'NT-IIII-LLLL-OOOO-AAAA-BBBB-CCCC-DDDD-EEEE';
  const service = deferredService();
  const view = await mount(t, service);
  await view.mounted;
  const input = byId(view.root, 'license-key');
  input.value = `  ${fresh.toLowerCase()}  `;
  await input.fire('input');
  const activating = byId(view.root, 'activate-plus').fire('click');
  assert.deepEqual(service.calls, [fresh]);
  service.finish({ status: 'active', plan: 'monthly', validUntil: '2026-12-14T00:00:00.000Z' });
  await activating;
  assert.equal(view.backend.current().licenseKey, fresh);

  await byId(view.root, 'remove-license').fire('click');
  input.value = legacy.toLowerCase();
  await input.fire('input');
  const legacyActivation = byId(view.root, 'activate-plus').fire('click');
  assert.equal(service.calls.at(-1), legacy);
  service.finish({ status: 'active', plan: '7_day_pass', validUntil: '2026-11-21T00:00:00.000Z' });
  await legacyActivation;
  assert.equal(view.backend.current().licenseKey, legacy);

  const saved = view.backend.current();
  const refresh = deferredService();
  const stored = await mount(t, refresh, saved);
  const pending = stored.mounted;
  await settle();
  refresh.finish({ status: 'active', plan: '7_day_pass', validUntil: '2026-11-21T00:00:00.000Z' });
  await pending;
  assert.equal(refresh.calls[0], legacy);
  assert.equal(stored.backend.current().licenseKey, legacy);

  const rejected = await mount(t, deferredService());
  await rejected.mounted;
  const invalid = byId(rejected.root, 'license-key');
  invalid.value = 'NT-1234';
  await invalid.fire('input');
  await byId(rejected.root, 'activate-plus').fire('click');
  assert.equal(byId(rejected.root, 'plus-error').textContent, 'Invalid license key. Please check and try again.');
  assert.equal(rejected.backend.current(), undefined);
});

test('a network failure while entering the first key does not save it', async t => {
  const service = deferredService();
  const view = await mount(t, service);
  await view.mounted;
  const input = byId(view.root, 'license-key');
  input.value = 'NT-DEV-NETWORK';
  await input.fire('input');
  const pending = byId(view.root, 'activate-plus').fire('click');
  service.fail();
  await pending;
  assert.equal(byId(view.root, 'plus-error').textContent, 'Unable to verify your license. Please try again.');
  assert.equal(view.backend.current(), undefined);
  assert.equal(view.root.dataset.state, 'free');
});
