import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM } from '../dom-fixture.mjs';
import { loadTs } from '../load-ts.mjs';

const { OPEN_SETTINGS_MESSAGE } = await loadTs('settings/messages.ts');

test('the preview message and toolbar action open the same extension settings page', async t => {
  const dom = installDOM(t);
  let onMessage;
  let onAction;
  let opens = 0;
  let fail = false;
  dom.setGlobal('defineBackground', handler => handler);
  dom.setGlobal('browser', {
    storage: {
      local: { get: async () => ({}), remove: async () => {} },
      onChanged: { addListener() {}, removeListener() {} },
    },
    action: { onClicked: { addListener: listener => { onAction = listener; } } },
    runtime: {
      openOptionsPage: async () => {
        opens += 1;
        if (fail) throw new Error('Options page unavailable');
      },
      onMessage: { addListener: listener => { onMessage = listener; } },
    },
  });
  const { default: startBackground } = await loadTs('entrypoints/background.ts');
  startBackground();
  const sendMessage = message => new Promise(resolve => {
    if (onMessage(message, {}, resolve) !== true) resolve(undefined);
  });
  await sendMessage({ type: 'unrelated-message' });
  assert.equal(opens, 0);
  assert.equal(await sendMessage({ type: OPEN_SETTINGS_MESSAGE }), true);
  assert.equal(opens, 1);
  onAction();
  assert.equal(opens, 2);
  fail = true;
  assert.equal(await sendMessage({ type: OPEN_SETTINGS_MESSAGE }), false);
  assert.equal(opens, 3);
});
