// Semantic structure observed in a live X quote composer on 2026-10-26.
// The attached post has neither quoteTweet nor a /status/ link.
export function attachedPost(document) {
  const attachment = document.createElement('div');
  attachment.dataset.testid = 'attachments';
  const wrapper = document.createElement('div');
  const label = document.createElement('span');
  label.textContent = 'Quote';
  const card = document.createElement('button');
  card.setAttribute('role', 'button');
  const author = document.createElement('div');
  author.dataset.testid = 'User-Name';
  const time = document.createElement('time');
  time.setAttribute('datetime', '2026-10-26T11:18:48.000Z');
  const text = document.createElement('div');
  text.dataset.testid = 'tweetText';
  text.textContent = 'An attached post';
  card.append(author, time, text);
  wrapper.append(label, card);
  attachment.append(wrapper);
  return { attachment, card, author, time, label };
}

// Composer structure observed in X Chat on 2026-11-09, both in an existing
// conversation and a newly opened self conversation. Message history is simulated.
export function chatComposer(document, { shadow = true, legacy = false, text = '这是一段聊天草稿' } = {}) {
  const host = document.createElement('div');
  host.dataset.testid = 'xchatEmbedRoute';
  const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
  const panel = document.createElement('div');
  panel.dataset.testid = 'dm-conversation-panel';
  const history = document.createElement('div');
  history.contentEditable = 'true';
  history.setAttribute('role', 'textbox');
  history.textContent = 'Simulated history, never an editor';
  const form = document.createElement('form');
  form.dataset.testid = 'dm-composer-form';
  const inputContainer = document.createElement('div');
  inputContainer.dataset.testid = 'dm-composer-input-container';
  const editor = document.createElement(legacy ? 'div' : 'textarea');
  editor.dataset.testid = legacy ? 'dmComposerTextInput' : 'dm-composer-textarea';
  editor.setAttribute('aria-label', 'Message');
  if (legacy) {
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.innerText = text;
  } else editor.value = text;
  const send = document.createElement('button');
  send.dataset.testid = 'dm-composer-send-button';
  send.setAttribute('type', 'submit');
  inputContainer.append(editor);
  form.append(inputContainer, send);
  panel.append(history, form);
  root.append(panel);
  document.body.append(host);
  return { host, root, panel, history, form, inputContainer, editor, send };
}
