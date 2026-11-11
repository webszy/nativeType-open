import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, settle } from '../dom-fixture.mjs';
import { loadTs } from '../load-ts.mjs';
import { settings, ANALYTICS_INSTALL_ID_KEY } from './fixture.mjs';

test('existing background listener validates internal messages and completes async receipts', async t => {
  const dom = installDOM(t);
  const storageListeners = new Set();
  const messages = [];
  const stored = { settings: settings(true) };
  let onMessage;
  let optionsOpened = 0;
  dom.setGlobal('__nativetypeTestEnv', { MODE: 'development', WXT_ANALYTICS_API_BASE_URL: 'https://analytics.test/api' });
  dom.setGlobal('fetch', async (url, init) => { messages.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); });
  dom.setGlobal('defineBackground', callback => callback);
  dom.setGlobal('browser', {
    action: { onClicked: { addListener() {} } },
    runtime: {
      id: 'internal-extension',
      openOptionsPage: async () => { optionsOpened += 1; },
      onMessage: { addListener: listener => { onMessage = listener; } },
    },
    storage: {
      local: {
        get: async () => ({ ...stored }),
        set: async value => Object.assign(stored, value),
        remove: async key => { delete stored[key]; },
      },
      onChanged: { addListener: listener => storageListeners.add(listener), removeListener: listener => storageListeners.delete(listener) },
    },
  });
  const { default: start } = await loadTs('entrypoints/background.ts');
  start();
  await settle();
  const send = (message, id = 'internal-extension') => new Promise(resolve => {
    const retained = onMessage(message, { id }, resolve);
    if (retained !== true) resolve(undefined);
  });
  assert.equal(await send({ type: 'analytics:event', event: 'translation_success' }), true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].url, 'https://analytics.test/api/v1/events');
  assert.deepEqual(Object.keys(messages[0].body).sort(), ['event', 'installId']);
  assert.ok(stored[ANALYTICS_INSTALL_ID_KEY]);
  assert.equal(await send({ type: 'analytics:event', event: 'typing' }), false);
  assert.equal(await send({ type: 'analytics:event', event: 'replace_success', text: 'private' }), false);
  assert.equal(await send({ type: 'analytics:event', event: 'replace_success' }, 'another-extension'), false);
  assert.equal(onMessage({ type: 'analytics:event', event: 'replace_success' }, { id: 'internal-extension' }, () => {
    throw new Error('Message port closed');
  }), true);
  await settle();
  assert.equal(messages.length, 2);
  const previous = stored.settings;
  stored.settings = settings(false);
  for (const listener of storageListeners) listener({ settings: { oldValue: previous, newValue: stored.settings } }, 'local');
  await settle();
  assert.equal(stored[ANALYTICS_INSTALL_ID_KEY], undefined);
  assert.equal(await send({ type: 'analytics:event', event: 'translation_success' }), false);
  assert.equal(messages.length, 2);
  assert.equal(await send({ type: 'nativetype:open-settings' }), true);
  assert.equal(optionsOpened, 1);
});
