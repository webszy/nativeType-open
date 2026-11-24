import { classifyTrigger, isLongEnoughToDetect, type LanguagePair } from '../languages/config';
import type { AnalyticsReporter } from '../analytics/client';
import { polishDraftLimit, type AnalyticsEventType, type AnalyticsEventContext, type AnalyticsSource } from '@nativetype/contracts';
import { PolishError, type PolishProvider } from '../ai/client';
import type { TriggerDetector } from '../languages/detector';
import type { PlatformAdapter } from '../platforms/types';
import { getDefaultSettings, sameSettings, type NativeTypeSettings, type SettingsStore } from '../settings/store';
import { TranslationError, type TranslationProvider } from '../translators/types';
import { createOverlay, type EntitlementBadgeSource, type PreviewState } from '../ui/overlay';
import { AUTOMATIC_TRANSLATION_DEBOUNCE_MS, beginRequest, cancelSession, createSession, isCurrentRequest, type RequestSnapshot, type TranslationSession } from './session';

export interface ExtensionHost {
  listen(target: Document | Window, type: string, listener: (event: Event) => void): void;
  onInvalidated(listener: () => void): void;
  openSettings?(): void | Promise<void>;
}

export function startNativeType(options: {
  platform: PlatformAdapter;
  provider: TranslationProvider;
  languagePair: LanguagePair;
  settings?: SettingsStore;
  detector?: TriggerDetector;
  analytics?: AnalyticsReporter;
  polish?: PolishProvider;
  host: ExtensionHost;
  logoUrl?: string;
  sparklesLoaderUrl?: string;
  entitlement?: EntitlementBadgeSource;
}): void {
  const { platform, provider, detector, host } = options;
  const defaults = getDefaultSettings();
  let settings: NativeTypeSettings = {
    ...defaults,
    translation: {
      ...defaults.translation,
      sourceLanguage: options.languagePair.source,
      targetLanguage: options.languagePair.target,
    },
  };
  const sessions = new WeakMap<HTMLElement, TranslationSession>();
  let session = createSession();
  let draftKey: string | undefined;
  let disposed = false;
  let syncingSettings = false;
  let improvedSnapshot: RequestSnapshot | undefined;
  interface AnalyticsDraft { id: string; key: string | undefined; stop: () => void }
  interface Candidate { id: string; sessionId: string; source: AnalyticsSource; shown: boolean; aiShown: boolean; clicked: boolean; replaced: boolean; dismissed: boolean; rewriteSuccess?: boolean }
  interface Candidates { local: Candidate; ai?: Candidate }
  const analyticsDrafts = new Map<HTMLElement, AnalyticsDraft>();
  const previewCandidates = new WeakMap<PreviewState, Candidates>();
  const cachedCandidates = new WeakMap<object, Candidates>();
  // Visibility observation only schedules controller telemetry, never changes UI.
  const exposureObserver = typeof IntersectionObserver === 'undefined' ? undefined
    : new IntersectionObserver(() => trackExposure());
  session.languagePair = {
    source: settings.translation.sourceLanguage,
    target: settings.translation.targetLanguage,
  };
  const overlay = createOverlay(() => {
    if (session.replacing) return;
    // Switching the candidate back to Local does not change the task's operation.
    if (session.preview?.kind === 'translated' && session.preview.ai && session.preview.ai.status !== 'idle') void improve();
    else void translate(true);
  }, async () => {
    if (syncingSettings || !session.editor || session.preview?.kind !== 'translated' || session.composing || session.replacing) return;
    if (!sameEditor(session.editor) || !contextEnabled(session.editor)) {
      deactivate();
      return;
    }
    if (platform.getText(session.editor) !== session.sourceText) {
      refresh();
      return;
    }
    // The selected AI text must still belong to this editor, revision, source and language pair.
    if (session.preview.ai?.selected === 'ai' && (!improvedSnapshot
      || !isCurrentRequest(session, improvedSnapshot, editor => platform.getText(editor)))) {
      refresh();
      return;
    }
    const editor = session.editor;
    const replacementSession = session;
    const translation = session.preview.text;
    trackExposure();
    const replacementCandidate = selectedCandidate();
    const source = session.sourceText;
    session.replacing = true;
    cancelSession(session);
    const revision = session.revision;
    let success = false;
    try {
      success = await platform.replaceText(editor, source, translation, () =>
        session === replacementSession && sameEditor(editor) && session.revision === revision && contextEnabled(editor));
    } catch {
      success = false;
    } finally {
      replacementSession.replacing = false;
    }
    if (session !== replacementSession || !sameEditor(editor) || session.revision !== revision || !contextEnabled(editor)) {
      refresh();
      return;
    }
    if (success) {
      session.sourceText = platform.getText(editor);
      session.preview = undefined;
      overlay.hide();
      if (replacementCandidate && !replacementCandidate.replaced) {
        replacementCandidate.replaced = true;
        reportCandidate('replace_success', replacementCandidate);
      }
    } else {
      session.preview = { kind: 'error', text: platform.replacementErrorMessage };
      showPreview(editor, session.preview);
    }
  }, editor => platform.previewLayout(editor), currentPair(), () => {
    const candidate = selectedCandidate();
    if (candidate?.shown && !candidate.dismissed) {
      candidate.dismissed = true;
      reportCandidate('preview_dismissed', candidate);
    }
    cancelSession(session);
  }, host.openSettings, options.polish ? {
    improve: () => {
      trackExposure();
      const candidate = session.preview && previewCandidates.get(session.preview)?.local;
      if (candidate && !candidate.clicked) {
        candidate.clicked = true;
        reportAnalytics('improve_with_ai_clicked', { sessionId: candidate.sessionId, previewId: candidate.id });
      }
      void improve();
    },
    select(view) {
      const preview = session.preview;
      if (preview?.kind !== 'translated' || !preview.ai || !session.editor
        || !sameEditor(session.editor) || !contextEnabled(session.editor)) return;
      if (platform.getText(session.editor) !== session.sourceText) { refresh(); return; }
      if (view === 'ai' && (!preview.ai.result || !improvedSnapshot
        || !isCurrentRequest(session, improvedSnapshot, editor => platform.getText(editor)))) return;
      preview.ai.selected = view;
      preview.text = view === 'ai' ? preview.ai.result!.text : preview.localText!;
      showPreview(session.editor, preview);
    },
  } : undefined, {
    logoUrl: options.logoUrl,
    sparklesLoaderUrl: options.sparklesLoaderUrl,
    entitlement: options.entitlement,
  });

  function uuid(): string | undefined {
    try { return crypto.randomUUID(); } catch { return; }
  }

  function releaseAnalyticsDraft(editor: HTMLElement) {
    const draft = analyticsDrafts.get(editor);
    analyticsDrafts.delete(editor);
    try { draft?.stop(); } catch { /* Best-effort telemetry cleanup. */ }
  }

  function analyticsDraft(editor: HTMLElement): AnalyticsDraft | undefined {
    try { return ensureAnalyticsDraft(editor); } catch { return; }
  }

  function ensureAnalyticsDraft(editor: HTMLElement): AnalyticsDraft | undefined {
    if (!settings.analytics.enabled || disposed || !contextEnabled(editor)) return;
    const existing = analyticsDrafts.get(editor);
    const key = platform.draftKey?.(editor);
    if (!platform.getText(editor).trim() || existing?.key !== key) releaseAnalyticsDraft(editor);
    if (!platform.getText(editor).trim()) return;
    const retained = analyticsDrafts.get(editor);
    if (retained) return retained;
    const id = uuid();
    if (!id) return;
    const draft: AnalyticsDraft = { id, key, stop: () => {} };
    analyticsDrafts.set(editor, draft);
    // Keep only lifecycle observation while another composer has focus. A publish
    // can clear an unfocused editor; its next draft must receive a fresh ID.
    draft.stop = platform.observe(editor, {
      onEdit() {
        if (session.editor === editor && session.replacing) return;
        if (!editor.isConnected || platform.findEditor(editor) !== editor || !platform.getText(editor).trim()
          || key !== platform.draftKey?.(editor)) releaseAnalyticsDraft(editor);
      },
      onDetach() { releaseAnalyticsDraft(editor); },
    });
    reportAnalytics('composer_session_started', { sessionId: id });
    return draft;
  }

  function candidate(source: AnalyticsSource, sessionId: string): Candidate | undefined {
    const id = uuid();
    return id ? { id, sessionId, source, shown: false, aiShown: false, clicked: false, replaced: false, dismissed: false } : undefined;
  }

  function selectedCandidate(): Candidate | undefined {
    if (session.preview?.kind !== 'translated') return;
    const candidates = previewCandidates.get(session.preview);
    return session.preview.ai?.selected === 'ai' ? candidates?.ai : candidates?.local;
  }

  function reportCandidate(event: 'preview_shown' | 'replace_success' | 'preview_dismissed', value: Candidate) {
    reportAnalytics(event, { sessionId: value.sessionId, previewId: value.id, source: value.source });
  }

  function actuallyVisible(element: HTMLElement | null): boolean {
    if (!element?.isConnected || document.visibilityState === 'hidden' || !overlay.isVisible()) return false;
    if (element.checkVisibility && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      if (node.hidden || node.inert || node.style.display === 'none') return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function trackExposure() {
    try { recordExposure(); } catch { /* Visibility checks cannot affect an action. */ }
  }

  function recordExposure() {
    if (!settings.analytics.enabled || session.preview?.kind !== 'translated' || !session.preview.text.trim()
      || !session.editor || !sameEditor(session.editor) || !contextEnabled(session.editor)
      || platform.getText(session.editor) !== session.sourceText) return;
    const candidates = previewCandidates.get(session.preview);
    const current = selectedCandidate();
    if (!current || current.sessionId !== (session.editor && analyticsDrafts.get(session.editor)?.id)) return;
    const result = overlay.host.shadowRoot?.querySelector<HTMLElement>('[data-part="result"]') ?? null;
    if (actuallyVisible(result)) {
      if (!current.shown) { current.shown = true; reportCandidate('preview_shown', current); }
      if (current.rewriteSuccess) {
        current.rewriteSuccess = false;
        reportAnalytics('ai_rewrite_success', { sessionId: current.sessionId, previewId: current.id });
      }
    }
    // This selector identifies the existing AI control; no UI behavior is changed.
    const button = overlay.host.shadowRoot?.querySelector<HTMLElement>('button[aria-describedby="nt-ai-privacy-tooltip"]') ?? null;
    if (candidates && !candidates.local.aiShown && actuallyVisible(button)) {
      candidates.local.aiShown = true;
      reportAnalytics('improve_with_ai_shown', { sessionId: candidates.local.sessionId, previewId: candidates.local.id });
    }
  }

  function showPreview(editor: HTMLElement, state: PreviewState) {
    overlay.show(editor, state);
    try {
      exposureObserver?.disconnect();
      if (state.kind === 'translated') {
        for (const element of overlay.host.shadowRoot?.querySelectorAll<HTMLElement>('[data-part="result"], button[aria-describedby="nt-ai-privacy-tooltip"]') ?? []) {
          exposureObserver?.observe(element);
        }
        trackExposure();
      }
    } catch { /* Telemetry must never break a displayed result. */ }
  }

  function localPreview(text: string): PreviewState {
    const preview: PreviewState = { kind: 'translated', text, ...(options.polish ? { localText: text, ai: { status: 'idle' as const, selected: 'local' as const } } : {}) };
    if (text.trim() && session.editor) {
      const draft = analyticsDraft(session.editor);
      if (draft) {
        let candidates = session.cached && cachedCandidates.get(session.cached);
        if (candidates?.local.sessionId !== draft.id) candidates = undefined;
        if (!candidates) {
          const local = candidate('local', draft.id);
          if (local) candidates = { local };
        }
        if (candidates) {
          previewCandidates.set(preview, candidates);
          if (session.cached) cachedCandidates.set(session.cached, candidates);
        }
      }
    }
    return preview;
  }

  function inheritCandidates(previous: PreviewState, next: PreviewState) {
    const candidates = previewCandidates.get(previous);
    if (candidates) previewCandidates.set(next, candidates);
  }

  async function improve() {
    const requestSession = session;
    const preview = session.preview;
    const editor = session.editor;
    if (!options.polish || syncingSettings || session.composing || session.replacing || !editor?.isConnected
      || preview?.kind !== 'translated' || !preview.localText || preview.ai?.status === 'loading') return;
    if (!sameEditor(editor) || !contextEnabled(editor)) { deactivate(); return; }
    const text = platform.getText(editor);
    if (text !== session.sourceText) { refresh(); return; }
    const pair = currentPair();
    const local = preview.localText;
    const writingContext = platform.writingContext(editor);
    if (writingContext === 'unknown') return;
    const limit = polishDraftLimit(writingContext);
    if (local.length > limit) {
      session.preview = { kind: 'translated', text: local, localText: local, ai: { status: 'error', selected: 'local',
        error: `AI Improve supports up to ${limit} characters of local translation here (${local.length}/${limit}). Shorten your draft and translate again.` } };
      inheritCandidates(preview, session.preview);
      showPreview(editor, session.preview);
      return;
    }
    const snapshot = beginRequest(session, editor, text);
    improvedSnapshot = undefined;
    session.preview = { kind: 'translated', text: local, localText: local, ai: { status: 'loading', selected: 'local' } };
    inheritCandidates(preview, session.preview);
    showPreview(editor, session.preview);
    const current = () => session === requestSession && !syncingSettings && !session.composing && !session.replacing
      && isCurrentRequest(session, snapshot, value => platform.getText(value))
      && sameEditor(editor) && contextEnabled(editor);
    try {
      const result = await options.polish({ source_language: pair.source, target_language: pair.target,
        original_source: text, draft: local, writing_context: writingContext }, snapshot.signal);
      if (!current()) return;
      improvedSnapshot = snapshot;
      session.preview = { kind: 'translated', text: result.text, localText: local, ai: { status: 'ready', selected: 'ai', result } };
      inheritCandidates(preview, session.preview);
      const candidates = previewCandidates.get(session.preview);
      if (candidates) {
        candidates.ai = result.text.trim() ? candidate('ai', candidates.local.sessionId) : undefined;
        if (candidates.ai) candidates.ai.rewriteSuccess = true;
      }
      showPreview(editor, session.preview);
    } catch (error) {
      if (!current()) return;
      const localCandidate = previewCandidates.get(preview)?.local;
      if (localCandidate && !(error instanceof Error && error.name === 'AbortError')) {
        reportAnalytics('ai_rewrite_error', { sessionId: localCandidate.sessionId, previewId: localCandidate.id });
      }
      session.preview = { kind: 'translated', text: local, localText: local, ai: { status: 'error', selected: 'local',
        requiresActivation: error instanceof PolishError && (error.code === 'UNAUTHORIZED' || error.code === 'PLUS_REQUIRED'),
        error: error instanceof PolishError ? error.message : 'AI Improve failed. Please retry.' } };
      inheritCandidates(preview, session.preview);
      showPreview(editor, session.preview);
    }
  }

  function currentPair(): LanguagePair {
    return {
      source: settings.translation.sourceLanguage,
      target: settings.translation.targetLanguage,
    };
  }

  function reportAnalytics(event: AnalyticsEventType, context: AnalyticsEventContext) {
    if (!settings.analytics.enabled || !context.sessionId
      || ![...analyticsDrafts.values()].some(draft => draft.id === context.sessionId)) return;
    try {
      const eventId = uuid();
      if (!eventId) return;
      void Promise.resolve(options.analytics?.(event, { ...context, eventId })).catch(() => {});
    } catch {
      // Analytics never changes translation, Preview, Replace, or Retry.
    }
  }

  function contextEnabled(editor: HTMLElement): boolean {
    if (disposed || platform.id !== 'x') return false;
    const context = platform.writingContext(editor);
    if (context === 'unknown') return false;
    return settings.contexts.x[context];
  }

  function sameEditor(editor: HTMLElement): boolean {
    return session.editor === editor && draftKey === platform.draftKey?.(editor);
  }

  function refresh(force = false) {
    if (syncingSettings || !session.editor) return;
    if (!sameEditor(session.editor)) {
      const editor = session.editor;
      deactivate();
      if (platform.findEditor(document.activeElement) === editor) activate(editor);
      return;
    }
    if (!contextEnabled(session.editor)) {
      deactivate();
      return;
    }
    if (session.replacing) return;
    const editor = session.editor;
    const text = platform.getText(editor);
    analyticsDraft(editor);
    // DOM mutations, repeated input events and a dismissed/filtered result must
    // not restart work for an unchanged draft.
    if (!force && text === session.sourceText) return;
    const keepVisible = overlay.isVisible();
    cancelSession(session);
    session.sourceText = text;
    session.preview = undefined;
    const pair = currentPair();
    const decision = classifyTrigger(text, pair.source);
    if (session.composing || !text.trim() || decision === 'skip' || (decision === 'detect' && !isLongEnoughToDetect(text))) {
      overlay.hide();
      return;
    }
    if (session.cached?.source === text && session.cached.sourceLanguage === pair.source && session.cached.targetLanguage === pair.target) {
      session.preview = localPreview(session.cached.translation);
      showPreview(editor, session.preview);
      return;
    }
    if (settings.translation.mode !== 'automatic') {
      session.preview = { kind: 'enable', text: 'Translate only when you ask.' };
      showPreview(editor, session.preview);
      return;
    }
    if (decision === 'match' && keepVisible) {
      session.preview = { kind: 'translating', text: 'Translating…' };
      showPreview(editor, session.preview);
    } else overlay.hide();
    const waitingSession = session;
    session.timer = setTimeout(() => {
      if (session !== waitingSession || settings.translation.mode !== 'automatic') return;
      session.timer = undefined;
      void translate(false);
    }, AUTOMATIC_TRANSLATION_DEBOUNCE_MS);
  }

  async function translate(activated: boolean) {
    if (syncingSettings || !session.editor?.isConnected || session.composing || session.replacing
      || (!activated && settings.translation.mode !== 'automatic')) return;
    const requestSession = session;
    const editor = session.editor;
    if (!sameEditor(editor)) {
      refresh();
      return;
    }
    if (!contextEnabled(editor)) {
      deactivate();
      return;
    }
    if (activated) editor.focus({ preventScroll: true });
    const text = platform.getText(editor);
    const pair = currentPair();
    const decision = classifyTrigger(text, pair.source);
    if (!text.trim() || decision === 'skip' || (decision === 'detect' && !isLongEnoughToDetect(text))) {
      refresh();
      return;
    }
    session.languagePair = pair;
    const snapshot = beginRequest(session, editor, text);
    session.requestMode = activated ? 'manual' : 'automatic';
    const analyticsContext = { sessionId: analyticsDraft(editor)?.id, mode: session.requestMode };
    const current = () => {
      if (session !== requestSession || session.composing || syncingSettings) return false;
      if (!isCurrentRequest(session, snapshot, value => platform.getText(value))) return false;
      if (!sameEditor(editor)) {
        refresh();
        return false;
      }
      if (!contextEnabled(editor)) {
        deactivate();
        return false;
      }
      return true;
    };
    function show(next: PreviewState) {
      if (!current()) return;
      session.preview = next;
      showPreview(editor, next);
    }
    const detectionProgress = (progress: number) => show({
      kind: 'downloading',
      text: detector?.detectionProgressText(progress) ?? `Downloading language detection… ${progress}%`,
    });
    let translationStarted = false;
    let translationCompleted = false;
    try {
      // Both creates run before the first await so the click keeps user activation.
      if (activated) {
        if (decision === 'detect') detector?.prepare(pair.source, detectionProgress);
        provider.prepare(pair.source, pair.target);
      }
      if (decision === 'match') show({ kind: 'translating', text: 'Translating…' });
      if (decision === 'detect') {
        if (!detector) {
          show({ kind: 'unsupported', text: 'Language detection is unavailable in this browser, so NativeType will not guess the input language.' });
          return;
        }
        const outcome = await detector.detect(text, pair.source, {
          signal: snapshot.signal,
          activated,
          onProgress: detectionProgress,
        });
        if (!current()) return;
        if (outcome.status === 'skip') {
          session.preview = undefined;
          overlay.hide();
          return;
        }
        if (outcome.status === 'enable') {
          show({ kind: 'enable', text: outcome.message });
          return;
        }
        if (outcome.status === 'unavailable') {
          show({ kind: 'unsupported', text: outcome.message });
          return;
        }
        if (outcome.status === 'error') {
          show({ kind: 'error', text: outcome.message });
          return;
        }
        show({ kind: 'translating', text: 'Translating…' });
      }
      translationStarted = true;
      const result = await provider.translate(text, {
        source: pair.source,
        target: pair.target,
        signal: snapshot.signal,
        activated,
        onProgress: progress => show({ kind: 'downloading', text: provider.downloadProgressText(progress) }),
      });
      if (!current()) return;
      translationCompleted = true;
      session.cached = { source: text, translation: result, sourceLanguage: pair.source, targetLanguage: pair.target };
      show(localPreview(result));
      if (result.trim() && current()) reportAnalytics('translation_success', analyticsContext);
    } catch (error) {
      if (!current()) return;
      show(error instanceof TranslationError
        ? { kind: error.kind, text: error.message }
        : { kind: 'error', text: 'Translation failed. Please retry.' });
      if (translationStarted && !translationCompleted
        && !(error instanceof Error && error.name === 'AbortError')
        && !(error instanceof TranslationError && error.kind === 'enable')) {
        reportAnalytics('translation_error', analyticsContext);
      }
    } finally {
      if (session === requestSession && session.revision === snapshot.revision) session.requestMode = undefined;
    }
  }

  function deactivate() {
    cancelSession(session);
    const stopObserving = session.stopObserving;
    session.stopObserving = undefined;
    stopObserving?.();
    if (session.editor && (!session.editor.isConnected
      || draftKey !== platform.draftKey?.(session.editor))) {
      sessions.delete(session.editor);
      session.cached = undefined;
    }
    draftKey = undefined;
    session.editor = null;
    session.sourceText = '';
    session.composing = false;
    session.compositionEvent = false;
    session.preview = undefined;
    overlay.hide();
  }

  function activate(editor: HTMLElement) {
    if (!contextEnabled(editor)) {
      if (session.editor) deactivate();
      return;
    }
    if (!sameEditor(editor)) {
      deactivate();
      session = sessions.get(editor) ?? createSession();
      if (session.draftKey !== platform.draftKey?.(editor)) session = createSession();
      sessions.set(editor, session);
      session.editor = editor;
      draftKey = platform.draftKey?.(editor);
      session.draftKey = draftKey;
      session.languagePair = currentPair();
      improvedSnapshot = undefined;
      session.stopObserving = platform.observe(editor, {
        onEdit() {
          if (session.editor !== editor) return;
          if (!sameEditor(editor) || !contextEnabled(editor) || platform.getText(editor) !== session.sourceText) refresh();
          overlay.reposition();
        },
        onDetach() {
          sessions.delete(editor);
          deactivate();
        },
      });
    }
    refresh();
  }

  function applySettings(next: NativeTypeSettings) {
    const pairChanged = settings.translation.sourceLanguage !== next.translation.sourceLanguage
      || settings.translation.targetLanguage !== next.translation.targetLanguage;
    const sourceChanged = settings.translation.sourceLanguage !== next.translation.sourceLanguage;
    const modeChanged = settings.translation.mode !== next.translation.mode;
    const keepCurrent = !pairChanged && session.editor && platform.getText(session.editor) === session.sourceText
      && (session.requestMode === 'manual' || session.preview?.kind === 'translated');
    if (settings.analytics.enabled !== next.analytics.enabled) {
      for (const editor of analyticsDrafts.keys()) releaseAnalyticsDraft(editor);
    }
    settings = next;
    session.languagePair = { source: next.translation.sourceLanguage, target: next.translation.targetLanguage };
    overlay.setLanguagePair(session.languagePair);
    if (pairChanged) {
      session.cached = undefined;
      cancelSession(session);
      session.preview = undefined;
      session.sourceText = '';
      provider.retainPair(next.translation.sourceLanguage, next.translation.targetLanguage);
      if (sourceChanged) detector?.reset();
    }
    if (modeChanged && next.translation.mode === 'manual') {
      clearTimeout(session.timer);
      session.timer = undefined;
      if (session.requestMode === 'automatic') {
        cancelSession(session);
      }
      if (!keepCurrent) {
        session.preview = undefined;
        overlay.hide();
      }
    }
    const focused = session.editor ?? platform.findEditor(document.activeElement);
    if (!focused || !contextEnabled(focused)) {
      if (session.editor) deactivate();
      return;
    }
    if (session.editor !== focused) activate(focused);
    else if (pairChanged || (modeChanged && !keepCurrent)) refresh(true);
  }

  let settingsEpoch = 0;
  const stopSettings = options.settings?.subscribe(next => {
    if (disposed) return;
    settingsEpoch += 1;
    if (!sameSettings(settings, next)) applySettings(next);
  });
  let reloadSettingsQueued = false;
  function previewHasFocus(): boolean {
    for (let focused = document.activeElement; focused; focused = focused.shadowRoot?.activeElement ?? null) {
      if (focused === overlay.host) return true;
    }
    return false;
  }

  async function reloadSettings() {
    if (!options.settings || disposed) return;
    if (syncingSettings) {
      reloadSettingsQueued = true;
      return;
    }
    syncingSettings = true;
    // A resumed tab may have missed storage notifications. Invalidate the old
    // preview and any pending paste before checking the persisted settings.
    cancelSession(session);
    session.sourceText = '';
    session.preview = undefined;
    // Removing the inline preview also removes its focused button. Keep the
    // composer focused while settings reload, including inside Chat's shadow root.
    if (previewHasFocus()) session.editor?.focus({ preventScroll: true });
    overlay.hide();
    try {
      do {
        reloadSettingsQueued = false;
        const loadEpoch = settingsEpoch;
        try {
          const loaded = await options.settings.load();
          if (!disposed && !reloadSettingsQueued && loadEpoch === settingsEpoch && !sameSettings(settings, loaded)) {
            applySettings(loaded);
          }
        } catch {
          // A transient storage failure keeps the last successfully read settings.
        }
      } while (!disposed && reloadSettingsQueued);
    } finally {
      syncingSettings = false;
      if (!disposed) {
        const focused = previewHasFocus() ? session.editor : platform.findEditor(document.activeElement);
        if (focused) activate(focused);
        else deactivate();
      }
    }
  }
  void reloadSettings();

  const resume = () => {
    if (document.visibilityState !== 'hidden') void reloadSettings();
  };
  host.listen(document, 'visibilitychange', resume);
  host.listen(window, 'focus', resume);
  host.listen(window, 'pageshow', resume);

  const eventEditor = (event: Event) => platform.findEditor(event.composedPath?.()[0] ?? event.target);
  host.listen(document, 'focusin', event => {
    if (event.target === overlay.host || event.composedPath?.().includes(overlay.host) || previewHasFocus()) return;
    const editor = eventEditor(event);
    if (editor) {
      if (editor !== session.editor) void reloadSettings();
      activate(editor);
    } else deactivate();
  });
  host.listen(document, 'focusout', () => {
    // Native focus transitions can expose BODY until the next task (including AX clicks).
    setTimeout(() => {
      if (!previewHasFocus() && !platform.findEditor(document.activeElement)) deactivate();
    });
  });
  host.listen(document, 'input', event => {
    if (session.replacing) return;
    const editor = eventEditor(event);
    if (!editor || platform.findEditor(document.activeElement) !== editor) return;
    if ((event as InputEvent).isComposing) {
      activate(editor);
      session.composing = true;
      cancelSession(session);
      session.preview = undefined;
      overlay.hide();
      return;
    }
    // Some editors expose isComposing without forwarding compositionstart/end.
    if (session.editor === editor && session.composing && !session.compositionEvent && (event as InputEvent).isComposing === false) {
      session.composing = false;
      refresh(true);
      return;
    }
    activate(editor);
  });
  host.listen(document, 'compositionstart', event => {
    const editor = eventEditor(event);
    if (!editor) return;
    activate(editor);
    if (session.editor !== editor) return;
    session.composing = true;
    session.compositionEvent = true;
    cancelSession(session);
    session.preview = undefined;
    overlay.hide();
  });
  host.listen(document, 'compositionend', event => {
    if (eventEditor(event) !== session.editor) return;
    session.composing = false;
    session.compositionEvent = false;
    refresh(true);
  });
  host.onInvalidated(() => {
    if (disposed) return;
    disposed = true;
    settingsEpoch += 1;
    stopSettings?.();
    exposureObserver?.disconnect();
    for (const editor of analyticsDrafts.keys()) releaseAnalyticsDraft(editor);
    deactivate();
    overlay.destroy();
    provider.dispose();
    detector?.dispose();
  });
  const focused = platform.findEditor(document.activeElement);
  if (focused) activate(focused);
}
