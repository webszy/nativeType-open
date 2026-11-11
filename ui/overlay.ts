import { describeLanguagePair, type LanguagePair } from '../languages/config';

export type PreviewState =
  | { kind: 'translating' | 'downloading' | 'error' | 'unsupported' | 'enable'; text: string }
  | { kind: 'translated'; text: string };

export interface OverlayLayout {
  container: HTMLElement;
  heightTarget?: HTMLElement;
  placement?: 'above';
}

function textLayout(editor: HTMLElement) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const range = document.createRange();
  let first: DOMRect | undefined;
  let bottom: number | undefined;
  let fontSize = parseFloat(getComputedStyle(editor).fontSize) || 16;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) range.selectNodeContents(node);
    else if (node.nodeName === 'BR') range.selectNode(node);
    else continue;
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.height <= 0) continue;
      bottom = Math.max(bottom ?? rect.bottom, rect.bottom);
      if (!first && rect.width > 0 && node.textContent?.trim()) {
        first = rect;
        fontSize = parseFloat(getComputedStyle(node.parentElement ?? editor).fontSize) || 16;
      }
    }
  }
  if (first && bottom !== undefined) return { left: first.left, bottom, indent: fontSize * 2 };
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const top = rect.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
  const left = rect.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0);
  return { left, bottom: bottom ?? top + (parseFloat(style.lineHeight) || fontSize * 1.2), indent: fontSize * 2 };
}

export function createOverlay(onRetry: () => void, onReplace: () => void, layoutFor: (editor: HTMLElement) => OverlayLayout, languagePair: LanguagePair, onClose?: () => void, onOpenSettings?: () => void | Promise<void>) {
  const host = document.createElement('div');
  host.dataset.nativetype = 'preview';
  host.setAttribute('translate', 'no');
  host.setAttribute('popover', 'manual');
  host.style.cssText = 'all:initial;position:fixed!important;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;z-index:2147483647!important;display:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    section { position:relative;background:var(--nt-bg,#fff);color:var(--nt-fg,#0f1419);border:1px solid var(--nt-border,#cfd9de);border-radius:12px;padding:12px 14px;box-shadow:0 8px 28px #0005;font:14px/1.45 system-ui,sans-serif; }
    header { display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;opacity:.65;margin-bottom:6px;padding-right:24px; }
    p { margin:0;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:var(--nt-text-height,160px); }
    footer { display:flex;justify-content:flex-end;gap:8px;margin-top:10px; }
    button { font:600 13px system-ui,sans-serif;cursor:pointer;border:1px solid var(--nt-border,#cfd9de);border-radius:999px;padding:6px 12px;background:transparent;color:inherit; }
    button:hover { background:#8882; }
    button:focus-visible { outline:2px solid #1d9bf0;outline-offset:2px; }
    button.primary { background:var(--nt-fg,#0f1419);color:var(--nt-bg,#fff);border-color:transparent; }
    button.close { position:absolute;top:6px;right:6px;width:24px;height:24px;padding:0;border:0;font:20px/1 system-ui,sans-serif;display:flex;align-items:center;justify-content:center; }
    button.settings { display:flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:3px;border:0; }
    button.settings:disabled { opacity:.5;cursor:wait; }
    button.settings svg { width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round; }
    [hidden] { display:none!important; }
  `;
  const panel = document.createElement('section');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'NativeType translation');
  let pair = languagePair;
  const label = document.createElement('header');
  const pairLabel = document.createElement('span');
  pairLabel.textContent = `NativeType · ${describeLanguagePair(pair)}`;
  label.append(pairLabel);
  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'settings';
  settings.title = 'Open settings';
  settings.setAttribute('aria-label', 'Open NativeType settings');
  if (onOpenSettings) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const wheel = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    wheel.setAttribute('d', 'M10 3h4l.5 2.5 2 1.2 2.4-.7 2 3.4L19 11v2l1.9 1.6-2 3.4-2.4-.7-2 1.2L14 21h-4l-.5-2.5-2-1.2-2.4.7-2-3.4L5 13v-2L3.1 9.4l2-3.4 2.4.7 2-1.2L10 3Z');
    const center = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    center.setAttribute('cx', '12');
    center.setAttribute('cy', '12');
    center.setAttribute('r', '3');
    icon.append(wheel, center);
    settings.append(icon);
    settings.addEventListener('click', async () => {
      settings.disabled = true;
      try {
        await onOpenSettings();
        settings.title = 'Open settings';
      } catch {
        settings.title = 'Couldn’t open settings. Reload X and try again.';
      } finally {
        settings.disabled = false;
      }
    });
    label.append(settings);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close translation preview');
  close.title = 'Close';
  close.addEventListener('click', () => {
    hide();
    onClose?.();
  });
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  const footer = document.createElement('footer');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.addEventListener('click', onRetry);
  const replace = document.createElement('button');
  replace.type = 'button';
  replace.className = 'primary';
  replace.textContent = 'Replace';
  replace.addEventListener('click', onReplace);
  // Keep the caret in X; its focus trap does not understand shadow-internal buttons.
  for (const button of [retry, replace, close, settings]) button.addEventListener('pointerdown', event => event.preventDefault());
  footer.append(retry, replace);
  panel.append(label, close, message, footer);
  shadow.append(style, panel);
  document.body.append(host);
  let anchor: HTMLElement | null = null;
  let visible = false;
  let frame = 0;
  let expanded: { target: HTMLElement; value: string; priority: string; minimum: number; edges: number } | null = null;

  function restoreHeight() {
    if (!expanded) return;
    const { target, value, priority } = expanded;
    if (value) target.style.setProperty('min-height', value, priority);
    else target.style.removeProperty('min-height');
    if (target !== anchor) observer.unobserve(target);
    expanded = null;
  }

  function reserveHeight(bottom: number) {
    if (!anchor) return;
    const target = layoutFor(anchor).heightTarget;
    if (!target) {
      restoreHeight();
      return;
    }
    if (expanded?.target !== target) {
      restoreHeight();
      const style = getComputedStyle(target);
      const edges = style.boxSizing === 'border-box' ? 0 :
        (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
        + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      expanded = {
        target,
        value: target.style.getPropertyValue('min-height'),
        priority: target.style.getPropertyPriority('min-height'),
        minimum: target.getBoundingClientRect().height - edges,
        edges,
      };
      if (target !== anchor) observer.observe(target);
    }
    const required = Math.max(expanded.minimum, bottom + 12 - target.getBoundingClientRect().top - expanded.edges);
    const value = `${Math.ceil(required)}px`;
    if (target.style.getPropertyValue('min-height') !== value || target.style.getPropertyPriority('min-height') !== 'important') {
      target.style.setProperty('min-height', value, 'important');
    }
  }

  function position() {
    frame = 0;
    if (!visible || !anchor?.isConnected) {
      restoreHeight();
      if (host.matches(':popover-open')) host.hidePopover();
      host.style.display = 'none';
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (rect.bottom <= 0 || rect.top >= height || rect.width === 0 || rect.right <= 0 || rect.left >= width) {
      restoreHeight();
      if (host.matches(':popover-open')) host.hidePopover();
      host.style.display = 'none';
      return;
    }
    // Match X's selected theme rather than the OS theme.
    for (let el: HTMLElement | null = anchor; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      const rgb = bg.match(/[\d.]+/g)?.map(Number);
      // X also uses transparent white: rgba(255, 255, 255, 0).
      if (!rgb || rgb.length < 3 || rgb[3] === 0) continue;
      const scale = bg.startsWith('color(srgb ') ? 255 : 1;
      const dark = ((rgb[0] ?? 255) + (rgb[1] ?? 255) + (rgb[2] ?? 255)) * scale < 384;
      host.style.setProperty('--nt-bg', bg);
      host.style.setProperty('--nt-fg', dark ? '#e7e9ea' : '#0f1419');
      host.style.setProperty('--nt-border', dark ? '#536471' : '#cfd9de');
      break;
    }
    host.style.width = `${Math.max(0, Math.min(420, Math.max(260, rect.width), width - 16) - 6)}px`;
    const line = textLayout(anchor);
    const above = layoutFor(anchor).placement === 'above';
    const gap = 4;
    const space = above ? rect.top - gap - 8 : height - line.bottom - gap - 8;
    // Stay four pixels below the last rendered line, including wraps and line breaks.
    host.style.setProperty('--nt-text-height', `${Math.max(36, Math.min(160, space - 92))}px`);
    host.style.display = 'block';
    // The top layer escapes transformed/clipped dialogs.
    // Keep the DOM inside the dialog so its focus boundary still contains the buttons.
    if (!host.matches(':popover-open')) host.showPopover();
    host.style.left = '0px';
    host.style.top = '0px';
    const panelHeight = host.getBoundingClientRect().height;
    const origin = host.getBoundingClientRect();
    const left = Math.max(8, Math.min(line.left + line.indent, width - origin.width - 8));
    const top = above ? Math.max(8, rect.top - panelHeight - gap) : line.bottom + gap;
    host.style.left = `${left - origin.left}px`;
    host.style.top = `${top - origin.top}px`;
    reserveHeight(top + panelHeight);
  }
  function schedule() {
    if (visible && !frame) frame = requestAnimationFrame(position);
  }
  function hide() {
    visible = false;
    restoreHeight();
    if (anchor) observer.unobserve(anchor);
    anchor = null;
    if (host.matches(':popover-open')) host.hidePopover();
    host.style.display = 'none';
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(panel);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  return {
    host,
    show(composer: HTMLElement, state: PreviewState) {
      if (anchor !== composer) {
        restoreHeight();
        if (anchor) observer.unobserve(anchor);
        anchor = composer;
        observer.observe(anchor);
      }
      // X traps focus and hides accessibility nodes outside its composer dialog.
      const container = layoutFor(composer).container;
      if (host.parentElement !== container) container.append(host);
      visible = true;
      message.textContent = state.text;
      message.lang = state.kind === 'translated' ? pair.target : '';
      retry.textContent = state.kind === 'enable' ? 'Enable translation' : 'Retry';
      retry.hidden = !['translated', 'error', 'enable'].includes(state.kind);
      replace.hidden = state.kind !== 'translated';
      footer.hidden = retry.hidden && replace.hidden;
      schedule();
    },
    isVisible: () => visible,
    setLanguagePair(next: LanguagePair) {
      pair = next;
      pairLabel.textContent = `NativeType · ${describeLanguagePair(pair)}`;
    },
    reposition: schedule,
    hide,
    destroy() {
      cancelAnimationFrame(frame);
      restoreHeight();
      if (host.matches(':popover-open')) host.hidePopover();
      observer.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      host.remove();
    },
  };
}
