import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../load-ts.mjs';
import { installDOM, settle } from '../dom-fixture.mjs';
import { chatComposer } from './x-fixture.mjs';

const { xPlatform } = await loadTs('platforms/x.ts');

test('Chat detects only the named draft, including focus retargeted through the live shadow host', t => {
  const { document } = installDOM(t);
  location.pathname = '/i/chat/100-200';
  const { host, editor, history } = chatComposer(document);
  editor.focus();
  assert.equal(document.activeElement, host);
  assert.equal(xPlatform.findEditor(host), editor);
  assert.equal(xPlatform.findEditor(editor), editor);
  assert.equal(xPlatform.writingContext(editor), 'chat');
  assert.equal(xPlatform.findEditor(history), null);
  assert.equal(xPlatform.writingContext(history), 'unknown');
  assert.equal(xPlatform.getText(editor), '这是一段聊天草稿');
  location.pathname = '/home';
  assert.equal(xPlatform.findEditor(host), null);
  assert.equal(xPlatform.writingContext(editor), 'unknown');
});

test('Chat accepts its route roots and conversation paths, without matching similarly named pages', t => {
  const { document } = installDOM(t);
  const { editor } = chatComposer(document);
  for (const path of ['/i/chat', '/i/chat/100-200', '/messages', '/messages/100-200']) {
    location.pathname = path;
    assert.equal(xPlatform.findEditor(editor), editor, path);
  }
  for (const path of ['/i/chatty', '/messages-search', '/compose/articles', '/home']) {
    location.pathname = path;
    assert.equal(xPlatform.findEditor(editor), null, path);
  }
});

test('disabled, read-only, hidden, menu and detached Chat inputs are excluded', t => {
  const { document } = installDOM(t);
  location.pathname = '/i/chat/100-200';
  const { editor, form } = chatComposer(document);
  for (const name of ['disabled', 'readonly', 'hidden', 'inert']) {
    editor.setAttribute(name, '');
    assert.equal(xPlatform.findEditor(editor), null, name);
    editor.attributes.delete(name);
  }
  form.setAttribute('role', 'menu');
  assert.equal(xPlatform.findEditor(editor), null);
  form.attributes.delete('role');
  editor.remove();
  assert.equal(xPlatform.findEditor(editor), null);
});

test('legacy DM contenteditable retains the existing paste adapter and gets its own context', t => {
  const { document } = installDOM(t);
  location.pathname = '/messages/100-200';
  const { editor } = chatComposer(document, { shadow: false, legacy: true });
  assert.equal(xPlatform.findEditor(editor), editor);
  assert.equal(xPlatform.writingContext(editor), 'chat');
  assert.equal(xPlatform.getText(editor), '这是一段聊天草稿');
});

test('Chat identity changes when its route or composer ownership changes, even with identical text', t => {
  const { document } = installDOM(t);
  location.pathname = '/i/chat/100-200';
  const { editor, form } = chatComposer(document);
  const first = xPlatform.draftKey(editor);
  location.pathname = '/i/chat/100-300';
  assert.notEqual(xPlatform.draftKey(editor), first);
  location.pathname = '/i/chat/100-200';
  assert.equal(xPlatform.draftKey(editor), first);
  form.append(editor);
  assert.notEqual(xPlatform.draftKey(editor), first);
});

test('Chat uses a preview above its draft without expanding the composer or message history', t => {
  const { document } = installDOM(t);
  const { editor } = chatComposer(document);
  assert.deepEqual(xPlatform.previewLayout(editor), { container: document.body, placement: 'above' });
});

test('Chat replacement synchronizes a simulated React value tracker, leaves a caret and emits no send event', async t => {
  const dom = installDOM(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  location.pathname = '/i/chat/100-200';
  const { editor } = chatComposer(dom.document);
  const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  let tracked = editor.value;
  let state = editor.value;
  let changes = 0;
  const events = [];
  Object.defineProperty(editor, 'value', {
    get() { return native.get.call(this); },
    set(value) { tracked = value; native.set.call(this, value); },
  });
  editor.addEventListener('input', event => {
    events.push(event);
    if (tracked === editor.value) return;
    tracked = state = editor.value;
    changes += 1;
  });
  for (const type of ['keydown', 'keypress', 'keyup', 'submit', 'paste']) editor.addEventListener(type, event => events.push(event));
  const replacing = xPlatform.replaceText(editor, state, 'Translated\nmessage');
  t.mock.timers.tick(0);
  await settle();
  dom.flushFrames();
  assert.equal(await replacing, true);
  assert.equal(state, 'Translated\nmessage');
  assert.equal(changes, 1);
  assert.deepEqual(events.map(event => event.type), ['input']);
  assert.equal(events[0].composed, true);
  assert.equal(events[0].inputType, 'insertReplacementText');
  assert.equal(editor.selectionStart, editor.value.length);
  assert.equal(editor.selectionEnd, editor.value.length);
  assert.equal(editor.getRootNode().activeElement, editor);
  native.set.call(editor, `${editor.value}!`);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  assert.equal(state, 'Translated\nmessage!');
});

for (const change of ['typing', 'route', 'permission', 'focus', 'unmount']) {
  test(`Chat replacement rechecks ${change} after the click handlers have finished`, async t => {
    const dom = installDOM(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    location.pathname = '/i/chat/100-200';
    const { editor, host } = chatComposer(dom.document);
    let allowed = true;
    let inputs = 0;
    editor.addEventListener('input', () => { inputs += 1; });
    const replacing = xPlatform.replaceText(editor, editor.value, 'Translation', () => allowed);
    if (change === 'typing') editor.value = '正在继续输入';
    if (change === 'route') location.pathname = '/i/chat/100-300';
    if (change === 'permission') allowed = false;
    if (change === 'focus') editor.getRootNode().activeElement = null;
    if (change === 'unmount') host.remove();
    t.mock.timers.tick(0);
    await settle();
    dom.flushFrames();
    assert.equal(await replacing, false);
    assert.equal(inputs, 0);
    assert.equal(editor.value, change === 'typing' ? '正在继续输入' : '这是一段聊天草稿');
  });
}

test('Chat observes the composer and its shadow-host removal, excludes history mutations and releases route listeners', t => {
  const dom = installDOM(t);
  location.pathname = '/i/chat/100-200';
  const { editor, history, host } = chatComposer(dom.document);
  let edits = 0;
  let detaches = 0;
  const stop = xPlatform.observe(editor, { onEdit: () => { edits += 1; }, onDetach: () => { detaches += 1; } });
  dom.mutate([{ type: 'childList', target: history }]);
  assert.equal(edits, 0);
  window.navigation.dispatchEvent({ type: 'currententrychange' });
  assert.equal(edits, 1);
  host.remove();
  dom.mutate([{ type: 'childList', target: dom.document.body }]);
  assert.equal(detaches, 1);
  stop();
  assert.equal(dom.observerCount(), 0);
  assert.equal(dom.routeListenerCount(), 0);
  window.navigation.dispatchEvent({ type: 'currententrychange' });
  assert.equal(edits, 1);
});
