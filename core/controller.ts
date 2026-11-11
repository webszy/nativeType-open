import { classifyTrigger, isLongEnoughToDetect, type LanguagePair } from '../languages/config';
import type { AnalyticsReporter } from '../analytics/client';
import type { AnalyticsEventType } from '@nativetype/contracts';
import type { TriggerDetector } from '../languages/detector';
import type { PlatformAdapter } from '../platforms/types';
import { getDefaultSettings, sameSettings, type NativeTypeSettings, type SettingsStore } from '../settings/store';
import { TranslationError, type TranslationProvider } from '../translators/types';
import { createOverlay, type PreviewState } from '../ui/overlay';
import { beginRequest, cancelSession, createSession, isCurrentRequest } from './session';

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
  host: ExtensionHost;
}): void {
  const { platform, provider, detector, host } = options;
  let settings: NativeTypeSettings = {
    ...getDefaultSettings(),
    translation: {
      sourceLanguage: options.languagePair.source,
      targetLanguage: options.languagePair.target,
    },
  };
  const session = createSession();
  let draftKey: string | undefined;
  let disposed = false;
  let syncingSettings = false;
  session.languagePair = {
    source: settings.translation.sourceLanguage,
    target: settings.translation.targetLanguage,
  };
  const overlay = createOverlay(() => {
    if (!session.replacing) void translate(true);
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
    const editor = session.editor;
    const translation = session.preview.text;
    const source = session.sourceText;
    session.replacing = true;
    cancelSession(session);
    const revision = session.revision;
    let success = false;
    try {
      success = await platform.replaceText(editor, source, translation, () =>
        sameEditor(editor) && session.revision === revision && contextEnabled(editor));
    } catch {
      success = false;
    } finally {
      session.replacing = false;
    }
    if (!sameEditor(editor) || session.revision !== revision || !contextEnabled(editor)) {
      refresh();
      return;
    }
    if (success) {
      session.sourceText = platform.getText(editor);
      session.preview = undefined;
      overlay.hide();
      reportAnalytics('replace_success');
    } else {
      session.preview = { kind: 'error', text: platform.replacementErrorMessage };
      overlay.show(editor, session.preview);
    }
  }, editor => platform.previewLayout(editor), currentPair(), () => {
    cancelSession(session);
  }, host.openSettings);

  function currentPair(): LanguagePair {
    return {
      source: settings.translation.sourceLanguage,
      target: settings.translation.targetLanguage,
    };
  }

  function reportAnalytics(event: AnalyticsEventType) {
    if (!settings.analytics.enabled) return;
    try {
      void Promise.resolve(options.analytics?.(event)).catch(() => {});
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

  function refresh() {
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
    if (text === session.sourceText && (session.preview || session.timer)) return;
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
      session.preview = { kind: 'translated', text: session.cached.translation };
      overlay.show(editor, session.preview);
      return;
    }
    if (decision === 'match' && keepVisible) {
      session.preview = { kind: 'translating', text: 'Translating…' };
      overlay.show(editor, session.preview);
    } else overlay.hide();
    session.timer = setTimeout(() => {
      session.timer = undefined;
      void translate(false);
    }, 1000);
  }

  async function translate(activated: boolean) {
    if (syncingSettings || !session.editor?.isConnected || session.composing) return;
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
    const current = () => {
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
      overlay.show(editor, next);
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
      show({ kind: 'translated', text: result });
      if (result.trim() && current()) reportAnalytics('translation_success');
    } catch (error) {
      if (!current()) return;
      show(error instanceof TranslationError
        ? { kind: error.kind, text: error.message }
        : { kind: 'error', text: 'Translation failed. Please retry.' });
      if (translationStarted && !translationCompleted
        && !(error instanceof Error && error.name === 'AbortError')
        && !(error instanceof TranslationError && error.kind === 'enable')) {
        reportAnalytics('translation_error');
      }
    }
  }

  function deactivate() {
    cancelSession(session);
    const stopObserving = session.stopObserving;
    session.stopObserving = undefined;
    stopObserving?.();
    if (draftKey !== undefined) session.cached = undefined;
    draftKey = undefined;
    session.editor = null;
    session.sourceText = '';
    session.composing = false;
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
      session.editor = editor;
      draftKey = platform.draftKey?.(editor);
      if (draftKey !== undefined) session.cached = undefined;
      session.stopObserving = platform.observe(editor, {
        onEdit() {
          if (session.editor !== editor) return;
          if (!sameEditor(editor) || !contextEnabled(editor) || platform.getText(editor) !== session.sourceText) refresh();
          overlay.reposition();
        },
        onDetach() {
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
    const focused = session.editor ?? platform.findEditor(document.activeElement);
    if (!focused || !contextEnabled(focused)) {
      if (session.editor) deactivate();
      return;
    }
    if (session.editor !== focused) activate(focused);
    else if (pairChanged) refresh();
  }

  let settingsEpoch = 0;
  const stopSettings = options.settings?.subscribe(next => {
    if (disposed) return;
    settingsEpoch += 1;
    if (!sameSettings(settings, next)) applySettings(next);
  });
  let reloadSettingsQueued = false;
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
        const focused = document.activeElement === overlay.host ? session.editor : platform.findEditor(document.activeElement);
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
    if (event.target === overlay.host) return;
    const editor = eventEditor(event);
    if (editor) {
      if (editor !== session.editor) void reloadSettings();
      activate(editor);
    } else deactivate();
  });
  host.listen(document, 'focusout', () => {
    // Native focus transitions can expose BODY until the next task (including AX clicks).
    setTimeout(() => {
      if (document.activeElement !== overlay.host && !platform.findEditor(document.activeElement)) deactivate();
    });
  });
  host.listen(document, 'input', event => {
    if (session.replacing) return;
    const editor = eventEditor(event);
    if (!editor || platform.findEditor(document.activeElement) !== editor) return;
    activate(editor);
  });
  host.listen(document, 'compositionstart', event => {
    const editor = eventEditor(event);
    if (!editor) return;
    activate(editor);
    if (session.editor !== editor) return;
    session.composing = true;
    cancelSession(session);
    session.preview = undefined;
    overlay.hide();
  });
  host.listen(document, 'compositionend', event => {
    if (eventEditor(event) !== session.editor) return;
    session.composing = false;
    refresh();
  });
  host.onInvalidated(() => {
    if (disposed) return;
    disposed = true;
    settingsEpoch += 1;
    stopSettings?.();
    deactivate();
    overlay.destroy();
    provider.dispose();
    detector?.dispose();
  });
  const focused = platform.findEditor(document.activeElement);
  if (focused) activate(focused);
}
