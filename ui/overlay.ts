import { languageEnglishName } from '../languages/catalog';
import type { LanguagePair } from '../languages/config';
import type { PolishSuccess } from '@nativetype/contracts';
import { createSparklesLoader } from './sparkles-loader';

export interface AIPreview {
  status: 'idle' | 'loading' | 'ready' | 'error';
  selected: 'local' | 'ai';
  result?: PolishSuccess;
  error?: string;
  requiresActivation?: boolean;
}

export type PreviewState =
  | { kind: 'translating' | 'downloading' | 'error' | 'unsupported' | 'enable'; text: string }
  | { kind: 'translated'; text: string; localText?: string; ai?: AIPreview };

export type PlanBadge = 'plus' | 'free' | 'unknown';

export interface EntitlementBadgeSource {
  load(): Promise<PlanBadge>;
  subscribe(listener: (badge: PlanBadge) => void): () => void;
}

/** Where the inline preview participates in normal layout flow. */
export interface OverlayLayout {
  container: HTMLElement;
  /** Insert the host before this node. Null appends it to the container. */
  before?: Node | null;
}

export interface OverlayOptions {
  logoUrl?: string;
  sparklesLoaderUrl?: string;
  entitlement?: EntitlementBadgeSource;
}

export function createOverlay(onRetry: () => void, onReplace: () => void, layoutFor: (editor: HTMLElement) => OverlayLayout, languagePair: LanguagePair, onClose?: () => void, onOpenSettings?: () => void | Promise<void>, aiActions?: { improve(): void; select(view: 'local' | 'ai'): void }, options?: OverlayOptions) {
  const host = document.createElement('div');
  host.dataset.nativetype = 'preview';
  host.setAttribute('data-nativetype', 'preview');
  host.setAttribute('translate', 'no');
  host.style.cssText = 'all:initial;display:none;position:static!important;left:auto;top:auto;right:auto;bottom:auto;float:none;z-index:auto;width:100%;max-width:100%;margin:0;padding:0;border:0;background:transparent!important;box-shadow:none;box-sizing:border-box;flex:0 0 auto;container-type:inline-size;color:#0f1419;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    section { background:transparent;color:inherit;border:0;border-radius:0;box-shadow:none;padding:0 0 2px;font:inherit; }
    .rule { display:flex;align-items:center;gap:8px;width:100%;margin:14px auto;border:0; }
    .rule::before, .rule-line { content:'';flex:1 1 0;min-width:0;height:1px;background:var(--nt-line,rgba(83,100,113,.35)); }
    .brand-help { position:relative;flex:none; }
    .brand-tooltip { display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:2;width:max-content;padding:6px 8px;border-radius:5px;background:var(--nt-fg,#0f1419);color:var(--nt-bg,#fff);font:400 12px/1.4 system-ui; }
    .brand-help:hover .brand-tooltip, .brand-help:focus-within .brand-tooltip { display:block; }
    button.brand { border:0;padding:4px 6px;border-radius:999px;background:var(--nt-badge,rgba(83,100,113,.12));color:inherit;cursor:pointer; }
    button.brand:hover { background:var(--nt-line,rgba(83,100,113,.35)); }
    .brand-external { opacity:0; }
    button.brand:hover .brand-external { opacity:1; }
    .brand { display:flex;align-items:center;gap:6px;flex:0 0 auto;white-space:nowrap; }
    .logo { width:20px;height:20px;flex:none;display:block;object-fit:contain; }
    .name { font-size:13px;font-weight:500;line-height:1.2; }
    .plan { flex:none;font-size:11px;font-weight:600;line-height:1;padding:3px 6px;border-radius:999px; }
    .plan[data-plan="free"] { color:var(--nt-muted,#536471);background:var(--nt-badge,rgba(83,100,113,.12)); }
    .plan[data-plan="plus"] { color:var(--nt-plus-fg,#0c7abf);background:var(--nt-plus-bg,rgba(29,155,240,.12)); }
    .trailing { display:flex;align-items:center;gap:2px;flex:none;margin-left:auto; }
    .language { font:400 11px/1.2 system-ui;color:var(--nt-muted,#536471);white-space:nowrap; }
    @container (max-width: 320px) { .rule { gap:4px; } .brand { gap:4px; } }
    .status { display:flex;align-items:flex-start;gap:8px;margin-top:10px; }
    .spinner { width:12px;height:12px;margin-top:4px;flex:none;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:nt-spin .8s linear infinite; }
    @keyframes nt-spin { to { transform:rotate(360deg); } }
    p { margin:0; }
    .result { white-space:pre-wrap;overflow-wrap:anywhere;font:inherit; }
    nav { display:flex;gap:6px;margin-top:8px; }
    nav button { font-size:11px;padding:4px 8px; }
    nav button[aria-pressed="true"] { background:#8883; }
    .ai-status { display:grid;align-items:center;min-height:32px;font-size:12px;margin-top:8px;color:var(--nt-muted,#536471); }
    .ai-status > * { grid-area:1 / 1;min-width:0; }
    .preview-body { display:grid; }
    .preview-content, .activation { grid-area:1 / 1;min-width:0; }
    .preview-body[data-activation="true"] { min-height:150px; }
    .activation { position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;background:var(--nt-bg,#fff);text-align:center;font:400 13px/1.45 system-ui; }
    .activation-actions { display:flex;justify-content:center;flex-wrap:wrap;gap:8px; }
    .activation a { color:inherit;text-decoration:underline;text-underline-offset:3px;align-self:center; }
    footer { position:relative;display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:12px; }
    .ai-help { display:flex;align-items:center; }
    .ai-tooltip { position:absolute;right:0;bottom:calc(100% + 6px);z-index:1;width:max-content;max-width:min(300px,100%);padding:8px 10px;border-radius:6px;background:var(--nt-fg,#0f1419);color:var(--nt-bg,#fff);font:400 12px/1.45 system-ui,sans-serif;overflow-wrap:anywhere; }
    .ai-tooltip::after { content:'';position:absolute;left:0;right:0;top:100%;height:6px; }
    button { font:600 13px/1.2 inherit;cursor:pointer;border:1px solid var(--nt-border,#cfd9de);border-radius:999px;padding:6px 12px;background:transparent;color:inherit; }
    button:hover { background:#8882; }
    button:disabled { opacity:.5;cursor:wait; }
    button:focus-visible { outline:2px solid #1d9bf0;outline-offset:2px; }
    button.primary { background:var(--nt-fg,#0f1419);color:var(--nt-bg,#fff);border-color:transparent; }
    button.primary:hover { background:var(--nt-fg,#0f1419); }
    button.close { flex:none;width:24px;height:24px;padding:0;border:0;background:transparent;color:var(--nt-muted,#536471);opacity:.7;font-family:inherit;font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center; }
    button.close:hover, button.close:focus-visible { color:var(--nt-fg,#0f1419);opacity:1;background:transparent; }
    [hidden] { display:none!important; }
  `;
  const panel = document.createElement('section');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'NativeType translation');
  const rule = document.createElement('div');
  rule.className = 'rule';
  rule.dataset.part = 'rule';
  rule.setAttribute('data-part', 'rule');
  let pair = languagePair;
  const brand = document.createElement('button');
  brand.type = 'button';
  brand.setAttribute('aria-label', 'Open NativeType settings');
  brand.setAttribute('aria-describedby', 'nt-brand-tooltip');
  brand.className = 'brand';
  const logo = document.createElement('img');
  logo.className = 'logo';
  logo.dataset.part = 'logo';
  logo.setAttribute('data-part', 'logo');
  logo.alt = '';
  logo.width = 20;
  logo.height = 20;
  logo.draggable = false;
  logo.setAttribute('aria-hidden', 'true');
  logo.hidden = true;
  const name = document.createElement('span');
  name.className = 'name';
  name.dataset.part = 'name';
  name.setAttribute('data-part', 'name');
  name.textContent = 'NativeType';
  const plan = document.createElement('span');
  plan.className = 'plan';
  plan.dataset.part = 'plan';
  plan.setAttribute('data-part', 'plan');
  plan.hidden = true;
  const external = document.createElement('span');
  external.className = 'brand-external';
  external.textContent = '↗';
  external.setAttribute('aria-hidden', 'true');
  brand.append(logo, name, plan, external);
  const brandHelp = document.createElement('div');
  brandHelp.className = 'brand-help';
  const brandTooltip = document.createElement('span');
  brandTooltip.id = 'nt-brand-tooltip';
  brandTooltip.className = 'brand-tooltip';
  brandTooltip.setAttribute('role', 'tooltip');
  brandTooltip.textContent = 'Open NativeType settings';
  brandHelp.append(brand, brandTooltip);
  const line = document.createElement('span');
  line.className = 'rule-line';
  line.setAttribute('aria-hidden', 'true');
  rule.append(brandHelp, line);
  brand.disabled = !onOpenSettings;
  brand.addEventListener('click', async () => {
    if (!onOpenSettings) return;
    brand.disabled = true;
    try {
      await onOpenSettings();
      brandTooltip.textContent = 'Open NativeType settings';
    } catch {
      brandTooltip.textContent = 'Couldn’t open settings. Reload X and try again.';
    } finally {
      brand.disabled = false;
    }
  });
  const language = document.createElement('span');
  language.setAttribute('aria-label', 'Translation target language');
  language.className = 'language';
  language.dataset.part = 'language';
  language.setAttribute('data-part', 'language');
  language.lang = 'en';
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
  const trailing = document.createElement('div');
  trailing.className = 'trailing';
  trailing.append(language, close);
  rule.append(trailing);
  const status = document.createElement('div');
  status.className = 'status';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.dataset.part = 'spinner';
  spinner.setAttribute('data-part', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  spinner.hidden = true;
  const message = document.createElement('p');
  message.className = 'result';
  message.dataset.part = 'result';
  message.setAttribute('data-part', 'result');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  status.append(spinner, message);
  const footer = document.createElement('footer');
  const views = document.createElement('nav');
  views.setAttribute('aria-label', 'Translation preview version');
  const local = document.createElement('button');
  local.type = 'button';
  local.textContent = 'Local';
  local.addEventListener('click', () => aiActions?.select('local'));
  const improved = document.createElement('button');
  improved.type = 'button';
  improved.textContent = 'AI Improved';
  improved.addEventListener('click', () => aiActions?.select('ai'));
  views.append(local, improved);
  views.hidden = true;
  const notice = document.createElement('div');
  notice.id = 'nt-ai-privacy-tooltip';
  notice.className = 'ai-tooltip';
  notice.setAttribute('role', 'tooltip');
  notice.textContent = 'Improve with AI sends your original draft and local translation to Cloudflare for cloud processing, only when clicked.';
  notice.hidden = true;
  const aiStatus = document.createElement('div');
  aiStatus.className = 'ai-status';
  aiStatus.hidden = true;
  const aiMessage = document.createElement('p');
  aiMessage.setAttribute('role', 'status');
  const sparklesLoader = createSparklesLoader({
    src: options?.sparklesLoaderUrl,
    size: 32,
    visible: false,
    text: 'Improving… You can still use Local.',
  });
  aiStatus.append(aiMessage, sparklesLoader.element);
  const improve = document.createElement('button');
  improve.type = 'button';
  improve.hidden = true;
  improve.setAttribute('aria-describedby', notice.id);
  improve.addEventListener('click', () => aiActions?.improve());
  const aiHelp = document.createElement('div');
  aiHelp.className = 'ai-help';
  aiHelp.hidden = true;
  aiHelp.append(improve, notice);
  let helpHovered = false;
  let helpFocused = false;
  let helpDismissed = false;
  function updateHelp() {
    notice.hidden = aiHelp.hidden || helpDismissed || !(helpHovered || helpFocused);
  }
  aiHelp.addEventListener('mouseenter', () => { helpHovered = true; helpDismissed = false; updateHelp(); });
  aiHelp.addEventListener('mouseleave', () => { helpHovered = false; updateHelp(); });
  improve.addEventListener('focus', () => { helpFocused = true; helpDismissed = false; updateHelp(); });
  improve.addEventListener('blur', () => { helpFocused = false; updateHelp(); });
  improve.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !notice.hidden) {
      helpDismissed = true;
      updateHelp();
      event.stopPropagation();
    }
  });
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.addEventListener('click', onRetry);
  const replace = document.createElement('button');
  replace.type = 'button';
  replace.className = 'primary';
  replace.textContent = 'Replace';
  replace.addEventListener('click', onReplace);
  // Keep the caret in X; its focus trap does not understand shadow-internal buttons.
  for (const button of [retry, replace, close, brand, local, improved, improve]) button.addEventListener('pointerdown', event => event.preventDefault());
  footer.append(aiHelp, retry, replace);
  const previewBody = document.createElement('div');
  previewBody.className = 'preview-body';
  const previewContent = document.createElement('div');
  previewContent.className = 'preview-content';
  previewContent.append(views, status, aiStatus, footer);
  const activation = document.createElement('div');
  activation.className = 'activation';
  activation.setAttribute('role', 'region');
  activation.setAttribute('aria-label', 'Activate NativeType Plus');
  activation.hidden = true;
  const activationText = document.createElement('p');
  const activationCopy = 'AI Improve requires an active Plus license. Get Plus, or activate or refresh your license in NativeType settings.';
  activationText.textContent = activationCopy;
  const pricing = document.createElement('a');
  pricing.href = 'https://typewith.si/pricing';
  pricing.target = '_blank';
  pricing.rel = 'noopener noreferrer';
  pricing.textContent = 'View Plus plans';
  const activationSettings = document.createElement('button');
  activationSettings.type = 'button';
  activationSettings.textContent = 'Open settings';
  activationSettings.hidden = !onOpenSettings;
  activationSettings.addEventListener('click', async () => {
    activationSettings.disabled = true;
    try {
      await onOpenSettings?.();
    } catch {
      activationText.textContent = 'Couldn’t open settings. Open NativeType from the extension toolbar to activate your license.';
    } finally {
      activationSettings.disabled = false;
    }
  });
  const activationDismiss = document.createElement('button');
  activationDismiss.type = 'button';
  activationDismiss.textContent = 'Use Local';
  let currentAI: AIPreview | undefined;
  let dismissedActivation: AIPreview | undefined;
  function dismissActivation() {
    dismissedActivation = currentAI;
    activation.hidden = true;
    previewContent.inert = false;
    previewBody.dataset.activation = 'false';
    anchor?.focus({ preventScroll: true });
  }
  activationDismiss.addEventListener('click', dismissActivation);
  activation.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      dismissActivation();
      event.stopPropagation();
    }
  });
  for (const control of [pricing, activationSettings, activationDismiss]) control.addEventListener('pointerdown', event => event.preventDefault());
  const activationActions = document.createElement('div');
  activationActions.className = 'activation-actions';
  activationActions.append(pricing, activationSettings, activationDismiss);
  activation.append(activationText, activationActions);
  previewBody.append(previewContent, activation);
  panel.append(rule, previewBody);
  shadow.append(style, panel);
  let anchor: HTMLElement | null = null;
  let visible = false;
  let disposed = false;
  let entitlementRevision = 0;
  const stopEntitlement = options?.entitlement?.subscribe(next => {
    entitlementRevision += 1;
    applyBadge(next);
  });
  const entitlementSnapshot = entitlementRevision;
  void options?.entitlement?.load().then(next => {
    if (disposed || entitlementRevision !== entitlementSnapshot) return;
    applyBadge(next);
  }, () => {
    if (!disposed && entitlementRevision === entitlementSnapshot) applyBadge('unknown');
  });
  applyLanguage();
  applyLogo(options?.logoUrl);

  function applyBadge(next: PlanBadge) {
    if (next === 'unknown') {
      plan.hidden = true;
      plan.textContent = '';
      plan.removeAttribute('data-plan');
      return;
    }
    plan.hidden = false;
    plan.dataset.plan = next;
    plan.setAttribute('data-plan', next);
    plan.textContent = next === 'plus' ? 'Plus' : 'Free';
  }

  function applyLanguage() {
    language.textContent = languageEnglishName(pair.target);
  }

  function applyLogo(url: string | undefined) {
    if (!url) {
      logo.removeAttribute('src');
      logo.hidden = true;
      return;
    }
    // The manifest exposes only this packaged image to x.com.
    logo.src = url;
    logo.setAttribute('src', url);
    logo.hidden = false;
  }

  function applyTheme(editor: HTMLElement) {
    let dark = false;
    for (let el: HTMLElement | null = editor; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      const rgb = bg.match(/[\d.]+/g)?.map(Number);
      if (!rgb || rgb.length < 3 || rgb[3] === 0) continue;
      const scale = bg.startsWith('color(srgb ') ? 255 : 1;
      dark = ((rgb[0] ?? 255) + (rgb[1] ?? 255) + (rgb[2] ?? 255)) * scale < 384;
      break;
    }
    host.dataset.theme = dark ? 'dark' : 'light';
    host.style.color = dark ? '#e7e9ea' : '#0f1419';
    const font = getComputedStyle(editor).font;
    if (font) host.style.font = font;
    host.style.setProperty('--nt-line', dark ? 'rgba(231, 233, 234, 0.22)' : 'rgba(83, 100, 113, 0.35)');
    host.style.setProperty('--nt-muted', dark ? '#8b98a5' : '#536471');
    host.style.setProperty('--nt-badge', dark ? 'rgba(231, 233, 234, 0.12)' : 'rgba(83, 100, 113, 0.12)');
    host.style.setProperty('--nt-plus-fg', dark ? '#8ecdf8' : '#0c7abf');
    host.style.setProperty('--nt-plus-bg', dark ? 'rgba(29, 155, 240, 0.2)' : 'rgba(29, 155, 240, 0.12)');
    host.style.setProperty('--nt-fg', dark ? '#e7e9ea' : '#0f1419');
    host.style.setProperty('--nt-bg', dark ? '#0f1419' : '#ffffff');
    host.style.setProperty('--nt-border', dark ? '#536471' : '#cfd9de');
  }

  function place(editor: HTMLElement) {
    const layout = layoutFor(editor);
    const parent = layout.container;
    if (!parent || parent === editor || editor.contains(parent)) return false;
    const reference = layout.before ?? null;
    // The slot is already ours when the draft’s next sibling is the host.
    if (reference === host || (host.parentNode === parent && host.nextSibling === reference)) return true;
    const before = reference && reference.parentNode === parent ? reference : null;
    parent.insertBefore(host, before);
    return true;
  }

  function hide() {
    sparklesLoader.setVisible(false);
    helpHovered = false;
    helpFocused = false;
    notice.hidden = true;
    visible = false;
    anchor = null;
    host.style.display = 'none';
    // Remove it so the composer’s last-child rules and height return to normal.
    if (host.isConnected) host.remove();
  }

  return {
    host,
    show(composer: HTMLElement, state: PreviewState) {
      if (!composer.isConnected) {
        hide();
        return;
      }
      anchor = composer;
      if (!place(composer)) {
        hide();
        return;
      }
      applyTheme(composer);
      visible = true;
      host.style.display = 'block';
      const loading = state.kind === 'translating' || state.kind === 'downloading';
      message.textContent = state.text;
      message.lang = state.kind === 'translated' ? pair.target : '';
      spinner.hidden = !loading;
      panel.setAttribute('aria-busy', String(loading));
      retry.textContent = state.kind === 'enable' ? 'Enable translation' : 'Retry';
      retry.hidden = !['translated', 'error', 'enable'].includes(state.kind);
      replace.hidden = state.kind !== 'translated';
      const ai = state.kind === 'translated' ? state.ai : undefined;
      currentAI = ai;
      const showActivation = !!ai?.requiresActivation && ai !== dismissedActivation;
      activation.hidden = !showActivation;
      previewContent.inert = showActivation;
      previewBody.dataset.activation = String(showActivation);
      if (showActivation) {
        activationText.textContent = activationCopy;
        if (shadow.activeElement && previewContent.contains(shadow.activeElement)) activationDismiss.focus({ preventScroll: true });
      }
      retry.disabled = ai?.status === 'loading';
      improve.hidden = !ai || !aiActions;
      aiHelp.hidden = improve.hidden;
      improve.disabled = ai?.status === 'loading';
      improve.textContent = ai?.status === 'loading' ? 'Improving…' : ai?.status === 'error' ? 'Retry AI' : 'Improve with AI';
      improve.setAttribute('aria-busy', String(ai?.status === 'loading'));
      updateHelp();
      views.hidden = !ai?.result;
      local.setAttribute('aria-pressed', String(ai?.selected === 'local'));
      improved.setAttribute('aria-pressed', String(ai?.selected === 'ai'));
      sparklesLoader.setVisible(ai?.status === 'loading');
      aiMessage.textContent = ai?.status === 'error' ? ai.error ?? 'AI Improve failed. Please retry.'
        : ai?.result?.entity_warnings ? 'Review mentions, links, amounts and versions before replacing.' : '';
      aiMessage.hidden = !aiMessage.textContent;
      // Reserve the compact loader row while AI is available, including before a request.
      aiStatus.hidden = !ai;
      footer.hidden = retry.hidden && replace.hidden && improve.hidden;
    },
    isVisible: () => visible,
    setLanguagePair(next: LanguagePair) {
      pair = next;
      applyLanguage();
      if (message.lang) message.lang = pair.target;
    },
    reposition() {
      if (!visible || !anchor?.isConnected) return;
      if (!place(anchor)) {
        hide();
        return;
      }
      applyTheme(anchor);
    },
    hide,
    destroy() {
      disposed = true;
      stopEntitlement?.();
      hide();
      host.remove();
    },
  };
}
