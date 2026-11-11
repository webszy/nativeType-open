import type { PlatformAdapter, PlatformEditorListener, PreviewLayout, WritingContext } from './types';

const composerSelector = '[contenteditable="true"][role="textbox"][data-testid^="tweetTextarea_"]';
const chatTextareaSelector = 'textarea[data-testid="dm-composer-textarea"]';
const legacyChatSelector = '[contenteditable="true"][data-testid="dmComposerTextInput"]';
const chatSelector = `${chatTextareaSelector}, ${legacyChatSelector}`;
const chatHostSelector = '[data-testid="xchatEmbedRoute"], [data-testid="xchatEmbedOverlays"]';

function parentOf(element: HTMLElement): HTMLElement | null {
  return element.parentElement ?? ((element.getRootNode() as ShadowRoot).host as HTMLElement | undefined) ?? null;
}

function isFocused(editor: HTMLElement): boolean {
  return (editor.getRootNode() as Document | ShadowRoot).activeElement === editor;
}

function isChatPath(pathname: string): boolean {
  return /^\/(?:i\/chat|messages)(?:\/|$)/.test(pathname);
}

function chatEditor(editor: HTMLElement): boolean {
  return isChatPath(location.pathname) && editor.isConnected && editor.matches(chatSelector)
    && !editor.closest(`${menuSelector}, [hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]`)
    && !editor.hasAttribute('disabled') && !editor.hasAttribute('readonly')
    && editor.getBoundingClientRect().width > 0 && editor.getBoundingClientRect().height > 0;
}

function findEditor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  // Document.activeElement and bubbling events are retargeted at X's open shadow host.
  if (target.matches(chatHostSelector)) return findEditor(target.shadowRoot?.activeElement ?? null);
  const post = target.closest<HTMLElement>(composerSelector);
  if (post) return post;
  const chat = target.closest<HTMLElement>(chatSelector);
  return chat && chatEditor(chat) ? chat : null;
}

function readText(editor: HTMLElement): string {
  if (editor.matches(chatTextareaSelector)) return (editor as HTMLTextAreaElement).value.replace(/\r\n/g, '\n');
  const blocks = editor.querySelectorAll<HTMLElement>('[data-block="true"]');
  const text = blocks.length ? Array.from(blocks, block => block.innerText.replace(/\n$/, '')).join('\n') : editor.innerText;
  return text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

async function replaceText(editor: HTMLElement, source: string, translation: string, canReplace: () => boolean = () => true): Promise<boolean> {
  if (editor.matches(chatTextareaSelector)) return replaceChatText(editor as HTMLTextAreaElement, source, translation, canReplace);
  if (editor.matches(legacyChatSelector)) {
    const key = draftKey(editor);
    const allowed = canReplace;
    canReplace = () => allowed() && chatEditor(editor) && draftKey(editor) === key;
  }
  if (!canReplace() || !editor.isConnected || readText(editor) !== source) return false;
  editor.focus({ preventScroll: true });
  // Finish the initiating click/focus handlers before changing X's selection.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (!canReplace() || !editor.isConnected || !isFocused(editor) || readText(editor) !== source) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  // Draft.js reads selection through React's onSelect; mouseup flushes that snapshot.
  editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  // X defers selection updates beyond the first animation frame.
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  if (!canReplace() || !editor.isConnected || !isFocused(editor) || readText(editor) !== source) return false;

  const currentRange = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
  // Draft normalizes element boundaries to text-node boundaries for the same selection.
  if (!currentRange || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)
    || currentRange.toString() !== range.toString()) return false;

  // X's Draft.js paste handler updates its editor state and renders the replacement.
  // Native insertText can mutate Draft's managed text nodes without synchronizing them.
  const clipboard = new DataTransfer();
  clipboard.setData('text/plain', translation);
  const handled = !editor.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: clipboard,
    bubbles: true,
    cancelable: true,
    composed: true,
  }));
  if (!handled) return false;
  await nextFrame();
  return readText(editor) === translation.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
}

async function replaceChatText(editor: HTMLTextAreaElement, source: string, translation: string, canReplace: () => boolean): Promise<boolean> {
  const key = draftKey(editor);
  const current = () => canReplace() && chatEditor(editor) && draftKey(editor) === key && readText(editor) === source;
  if (!current()) return false;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) return false;
  editor.focus({ preventScroll: true });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (!current() || !isFocused(editor)) return false;
  // Bypass React's per-element value tracker, then notify its input/onChange handler.
  // Setting value on the instance (or changing the DOM text) leaves controlled state stale.
  setValue.call(editor, translation);
  editor.dispatchEvent(new InputEvent('input', {
    bubbles: true, composed: true, inputType: 'insertReplacementText', data: translation,
  }));
  editor.setSelectionRange(editor.value.length, editor.value.length);
  await nextFrame();
  return canReplace() && chatEditor(editor) && draftKey(editor) === key && readText(editor) === translation.replace(/\r\n/g, '\n');
}

const menuSelector = '[role="menu"], [role="menuitem"], [data-testid="Dropdown"]';

export interface WritingSignals {
  connected: boolean;
  inMenu: boolean;
  quoteInShell: boolean;
  quoteOutsideShell: boolean;
  reply: boolean;
}

export function isStatusReplyPath(pathname: string): boolean {
  return /\/status\/\d+/.test(pathname);
}

export function resolveWritingContext(signals: WritingSignals): 'post' | 'reply' | 'quote' | 'unknown' {
  if (!signals.connected || signals.inMenu) return 'unknown';
  if (signals.quoteInShell) return 'quote';
  if (signals.quoteOutsideShell && signals.reply) return 'unknown';
  if (signals.quoteOutsideShell) return 'quote';
  if (signals.reply) return 'reply';
  return 'post';
}

function shellOf(editor: HTMLElement): HTMLElement {
  let shell: HTMLElement = editor;
  for (let node = editor.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    if (node === document.body || node.matches('[data-testid="primaryColumn"]')) break;
    const editors = node.querySelectorAll(composerSelector);
    const onlyThisEditor = editors.length === 1 && editors[0] === editor;
    if (!onlyThisEditor) break;
    const parentTweet = [...node.querySelectorAll('article[data-testid="tweet"]')].some(article => !article.contains(editor));
    if (parentTweet) break;
    shell = node;
  }
  return shell;
}

function isComposerQuote(quote: Element, editor: HTMLElement): boolean {
  if (editor.contains(quote) || quote.closest(menuSelector)) return false;
  const tweet = quote.closest('article[data-testid="tweet"]');
  if (tweet && !tweet.contains(editor)) return false;
  let owner = quote.parentElement;
  while (owner && !owner.contains(editor)) owner = owner.parentElement;
  const editors = owner?.querySelectorAll(composerSelector);
  return editors?.length === 1 && editors[0] === editor;
}

function hasComposerQuote(scope: ParentNode, editor: HTMLElement): boolean {
  if ([...scope.querySelectorAll('[data-testid="quoteTweet"]')].some(quote => isComposerQuote(quote, editor))) return true;
  // Current X renders a quote as an attached post button, without quoteTweet
  // or a status link. Require its author and timestamp so media/link cards
  // and the quoted post inside a reply's parent tweet do not count.
  return [...scope.querySelectorAll('[data-testid="attachments"]')].some(attachment =>
    isComposerQuote(attachment, editor)
    && [...attachment.querySelectorAll('button[role="button"]')].some(card =>
      isComposerQuote(card, editor)
      && card.querySelector('[data-testid="User-Name"]')
      && card.querySelector('time[datetime]')));
}

function hasReplyAnchor(editor: HTMLElement, shell: HTMLElement): boolean {
  const dialog = editor.closest('[role="dialog"]');
  if (dialog) {
    return [...dialog.querySelectorAll('article[data-testid="tweet"]')].some(article => !article.contains(editor) && !shell.contains(article));
  }
  let node: HTMLElement | null = shell;
  while (node && !node.matches('[data-testid="primaryColumn"]')) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.querySelector('article[data-testid="tweet"]')) return true;
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return isStatusReplyPath(location.pathname);
}

function writingContext(editor: HTMLElement): WritingContext {
  if (editor.matches(chatSelector)) return chatEditor(editor) ? 'chat' : 'unknown';
  if (!editor.matches(composerSelector)) return 'unknown';
  const shell = editor.isConnected ? shellOf(editor) : editor;
  const dialog = editor.closest('[role="dialog"]');
  const quoteInShell = editor.isConnected && hasComposerQuote(shell, editor);
  const outsideScope = dialog && dialog !== shell ? dialog : null;
  return resolveWritingContext({
    connected: editor.isConnected,
    inMenu: editor.closest(menuSelector) !== null,
    quoteInShell,
    quoteOutsideShell: !quoteInShell && !!outsideScope && hasComposerQuote(outsideScope, editor),
    reply: editor.isConnected && hasReplyAnchor(editor, shell),
  });
}

const chatScopes = new WeakMap<HTMLElement, number>();
let nextChatScope = 0;

function draftKey(editor: HTMLElement): string | undefined {
  if (!editor.matches(chatSelector)) return undefined;
  // Use only route and composer ownership, never message history or recipient text.
  const scope = editor.parentElement ?? editor;
  let id = chatScopes.get(scope);
  if (id === undefined) {
    id = ++nextChatScope;
    chatScopes.set(scope, id);
  }
  return `${location.pathname}:${id}`;
}

function previewLayout(editor: HTMLElement): PreviewLayout {
  if (editor.matches(chatSelector)) {
    return {
      container: editor.closest<HTMLElement>('[role="dialog"]') ?? document.body,
      placement: 'above',
    };
  }
  return {
    container: editor.closest<HTMLElement>('[role="dialog"]') ?? document.body,
    heightTarget: editor.closest<HTMLElement>('[data-testid$="RichTextInputContainer"]') ?? editor,
  };
}

function observe(editor: HTMLElement, listener: PlatformEditorListener): () => void {
  const chat = editor.matches(chatSelector);
  // A Chat observer stays around the composer, outside the message history.
  const scope = chat ? editor.closest<HTMLElement>('[data-testid="dm-composer-form"]') ?? editor.parentElement ?? editor
    : editor.closest<HTMLElement>('[role="dialog"]') ?? shellOf(editor);
  const observer = new MutationObserver(records => {
    if (!editor.isConnected) {
      listener.onDetach();
      return;
    }
    if (records.length) listener.onEdit();
  });
  observer.observe(editor, { childList: true, subtree: true, characterData: true });
  // Quote attachments and reply anchors can change without changing the draft.
  observer.observe(scope, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-testid', 'role', 'datetime', 'disabled', 'readonly', 'contenteditable', 'aria-disabled', 'aria-hidden', 'hidden', 'inert'],
  });
  // Watch only direct child changes along its ancestor path so removal of
  // the composer or an enclosing dialog also releases the observer.
  for (let node: HTMLElement | null = editor; node; node = parentOf(node)) {
    const parent = parentOf(node);
    if (!node.parentElement && node.getRootNode() !== document) observer.observe(node.getRootNode(), { childList: true });
    if (parent && parent !== scope) {
      if (chat) observer.observe(parent, { childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'aria-disabled'] });
      else observer.observe(parent, { childList: true });
    }
  }
  const onRouteChange = () => listener.onEdit();
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  if (chat) {
    // currententrychange also covers pushState/replaceState in X's SPA.
    navigation?.addEventListener('currententrychange', onRouteChange);
    window.addEventListener('popstate', onRouteChange);
  }
  return () => {
    observer.disconnect();
    if (chat) {
      navigation?.removeEventListener('currententrychange', onRouteChange);
      window.removeEventListener('popstate', onRouteChange);
    }
  };
}

export const xPlatform: PlatformAdapter = {
  id: 'x',
  replacementErrorMessage: 'X could not accept the replacement. Your current draft is still in the editor. Retry translation before replacing again.',
  matches: location => location.hostname === 'x.com',
  findEditor,
  writingContext,
  draftKey,
  getText: readText,
  replaceText,
  observe,
  previewLayout,
};
