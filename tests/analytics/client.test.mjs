import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../load-ts.mjs';
import { settle } from '../dom-fixture.mjs';

const { createAnalyticsClient, eventFromMessage, ANALYTICS_EVENT_MESSAGE } = await loadTs('analytics/client.ts');

test('client sends only the shared event name and message type', () => {
  const messages = [];
  const report = createAnalyticsClient(async message => { messages.push(message); });
  for (const event of ['translation_success', 'replace_success', 'translation_error']) report(event);
  report('typing');
  assert.deepEqual(messages, ['translation_success', 'replace_success', 'translation_error'].map(event => ({ type: ANALYTICS_EVENT_MESSAGE, event })));
});

test('client absorbs both a rejected message and a synchronous stopped-context exception', async () => {
  for (const send of [async () => { throw new Error('No receiver'); }, () => { throw new Error('Invalid context'); }]) {
    assert.doesNotThrow(() => createAnalyticsClient(send)('translation_success'));
  }
  await settle();
});

test('background message validation rejects unknown events and extra content', () => {
  for (const value of [null, [], {}, { event: 'translation_success' },
    { type: ANALYTICS_EVENT_MESSAGE, event: 'typing' },
    { type: ANALYTICS_EVENT_MESSAGE, event: 'translation_success', text: 'private draft' }]) {
    assert.equal(eventFromMessage(value), undefined);
  }
  assert.equal(eventFromMessage({ type: ANALYTICS_EVENT_MESSAGE, event: 'translation_success' }), 'translation_success');
});
