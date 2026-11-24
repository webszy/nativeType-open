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
  assert.deepEqual(eventFromMessage({ type: ANALYTICS_EVENT_MESSAGE, event: 'translation_success' }), { event: 'translation_success' });
});

test('modern context crosses messaging intact and rejects content or incomplete new events', () => {
  const context = { eventId: crypto.randomUUID(), sessionId: crypto.randomUUID(), previewId: crypto.randomUUID(), source: 'ai' };
  const messages = [];
  const report = createAnalyticsClient(async message => { messages.push(message); });
  report('replace_success', context);
  report('replace_success', context); // Transport retry keeps the original event ID.
  assert.equal(messages[0].eventId, messages[1].eventId);
  assert.deepEqual(eventFromMessage(messages[0]), { event: 'replace_success', ...context });
  report('preview_shown', { ...context, text: 'private draft' });
  report('preview_shown', {});
  assert.equal(messages.length, 2);
});
