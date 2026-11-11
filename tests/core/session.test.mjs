import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../load-ts.mjs';

const { beginRequest, cancelSession, createSession, isCurrentRequest } = await loadTs('core/session.ts');
const editor = (text, connected = true) => ({ text, isConnected: connected });
const read = value => value.text;

test('a newer request invalidates the previous one', () => {
  const session = createSession();
  const target = editor('甲');
  session.editor = target;
  const first = beginRequest(session, target, '甲');
  assert.equal(isCurrentRequest(session, first, read), true);
  target.text = '乙';
  const second = beginRequest(session, target, '乙');
  assert.equal(first.signal.aborted, true);
  assert.equal(isCurrentRequest(session, first, read), false);
  assert.equal(isCurrentRequest(session, second, read), true);
  assert.equal(session.revision, 2);
});

test('source equality, editor identity, and connection keep a request current', () => {
  const session = createSession();
  const target = editor('甲');
  session.editor = target;
  const snapshot = beginRequest(session, target, '甲');
  session.editor = editor('甲');
  assert.equal(isCurrentRequest(session, snapshot, read), false);
  session.editor = target;
  target.isConnected = false;
  assert.equal(isCurrentRequest(session, snapshot, read), false);
  target.isConnected = true;
  target.text = '乙';
  assert.equal(isCurrentRequest(session, snapshot, read), false);
  target.text = '甲';
  assert.equal(isCurrentRequest(session, snapshot, read), true);
});

test('a language change makes the previous request stale', () => {
  const session = createSession();
  const target = editor('甲');
  session.editor = target;
  session.languagePair = { source: 'zh', target: 'en' };
  const snapshot = beginRequest(session, target, '甲');
  assert.equal(isCurrentRequest(session, snapshot, read), true);
  session.languagePair = { source: 'en', target: 'zh' };
  assert.equal(isCurrentRequest(session, snapshot, read), false);
});

test('cancel aborts the active request and clears its debounce timer', async () => {
  const session = createSession();
  const snapshot = beginRequest(session, editor('甲'), '甲');
  let fired = false;
  session.timer = setTimeout(() => { fired = true; }, 20);
  cancelSession(session);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(snapshot.signal.aborted, true);
  assert.equal(session.abort, undefined);
  assert.equal(session.timer, undefined);
  assert.equal(fired, false);
  assert.equal(session.revision, snapshot.revision + 1);
});
