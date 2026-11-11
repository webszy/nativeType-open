import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../load-ts.mjs';
import { installDOM } from '../dom-fixture.mjs';
import { attachedPost } from './x-fixture.mjs';

const { isStatusReplyPath, resolveWritingContext, xPlatform } = await loadTs('platforms/x.ts');

const signals = (overrides) => ({
  connected: true,
  inMenu: false,
  quoteInShell: false,
  quoteOutsideShell: false,
  reply: false,
  ...overrides,
});

test('writing context follows the active composer signals', () => {
  assert.equal(resolveWritingContext(signals({})), 'post');
  assert.equal(resolveWritingContext(signals({ reply: true })), 'reply');
  assert.equal(resolveWritingContext(signals({ quoteInShell: true })), 'quote');
  assert.equal(resolveWritingContext(signals({ quoteInShell: true, reply: true })), 'quote');
  assert.equal(resolveWritingContext(signals({ quoteOutsideShell: true })), 'quote');
  assert.equal(resolveWritingContext(signals({ quoteOutsideShell: true, reply: true })), 'unknown');
  assert.equal(resolveWritingContext(signals({ connected: false })), 'unknown');
  assert.equal(resolveWritingContext(signals({ inMenu: true })), 'unknown');
});

test('only a status permalink is treated as an inline reply path', () => {
  assert.equal(isStatusReplyPath('/someone/status/123'), true);
  assert.equal(isStatusReplyPath('/i/web/status/123'), true);
  assert.equal(isStatusReplyPath('/home'), false);
  assert.equal(isStatusReplyPath('/compose/post'), false);
  assert.equal(isStatusReplyPath('/someone/status/'), false);
});

function composer(document, container = document.body) {
  const shell = document.createElement('div');
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.dataset.testid = 'tweetTextarea_0';
  shell.append(editor);
  container.append(shell);
  return { shell, editor };
}

test('the live X attached-post structure is a quote without quoteTweet, links, or English copy', t => {
  const { document } = installDOM(t);
  const { shell, editor } = composer(document);
  const { attachment, card, label } = attachedPost(document);
  label.textContent = '引用';
  shell.append(attachment);
  assert.equal(xPlatform.writingContext(editor), 'quote');
  card.remove();
  assert.equal(xPlatform.writingContext(editor), 'post');
});

test('legacy quoteTweet attachments are still recognized', t => {
  const { document } = installDOM(t);
  const { shell, editor } = composer(document);
  const quote = document.createElement('div');
  quote.dataset.testid = 'quoteTweet';
  shell.append(quote);
  assert.equal(xPlatform.writingContext(editor), 'quote');
});

test('replying to a post containing an attached quote remains a reply', t => {
  const { document } = installDOM(t);
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const article = document.createElement('article');
  article.dataset.testid = 'tweet';
  const { attachment } = attachedPost(document);
  article.append(attachment);
  dialog.append(article);
  document.body.append(dialog);
  const { editor } = composer(document, dialog);
  assert.equal(xPlatform.writingContext(editor), 'reply');
});

test('quote attachments in a menu or another composer do not change the active context', t => {
  const { document } = installDOM(t);
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.append(dialog);
  const first = composer(document, dialog);
  const second = composer(document, dialog);
  const quote = attachedPost(document);
  first.shell.append(quote.attachment);
  assert.equal(xPlatform.writingContext(first.editor), 'quote');
  assert.equal(xPlatform.writingContext(second.editor), 'post');
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.append(quote.attachment);
  second.shell.append(menu);
  assert.equal(xPlatform.writingContext(second.editor), 'post');
});

test('ordinary media/link attachments do not count as quoted posts', t => {
  const { document } = installDOM(t);
  const { shell, editor } = composer(document);
  const { attachment, time } = attachedPost(document);
  time.remove();
  shell.append(attachment);
  assert.equal(xPlatform.writingContext(editor), 'post');
});

test('late timestamp hydration notifies the active composer of a quote context change', t => {
  const dom = installDOM(t);
  const { shell, editor } = composer(dom.document);
  const { attachment, time } = attachedPost(dom.document);
  time.attributes.delete('datetime');
  shell.append(attachment);
  let edits = 0;
  const stop = xPlatform.observe(editor, { onEdit: () => { edits += 1; }, onDetach() {} });
  assert.equal(xPlatform.writingContext(editor), 'post');
  time.setAttribute('datetime', '2026-10-26T11:18:48.000Z');
  dom.mutate([{ type: 'attributes', target: time, attributeName: 'datetime' }]);
  assert.equal(edits, 1);
  assert.equal(xPlatform.writingContext(editor), 'quote');
  stop();
});
