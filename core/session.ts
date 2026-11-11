import type { PreviewState } from '../ui/overlay';

export interface TranslationSession {
  editor: HTMLElement | null;
  revision: number;
  sourceText: string;
  preview: PreviewState | undefined;
  abort: AbortController | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  composing: boolean;
  replacing: boolean;
  languagePair: { source: string; target: string } | undefined;
  cached: { source: string; translation: string; sourceLanguage: string; targetLanguage: string } | undefined;
  stopObserving: (() => void) | undefined;
}

export interface RequestSnapshot {
  revision: number;
  editor: HTMLElement;
  text: string;
  signal: AbortSignal;
  sourceLanguage: string | undefined;
  targetLanguage: string | undefined;
}

export function createSession(): TranslationSession {
  return {
    editor: null,
    revision: 0,
    sourceText: '',
    preview: undefined,
    abort: undefined,
    timer: undefined,
    composing: false,
    replacing: false,
    languagePair: undefined,
    cached: undefined,
    stopObserving: undefined,
  };
}

export function cancelSession(session: TranslationSession): void {
  clearTimeout(session.timer);
  session.timer = undefined;
  session.abort?.abort();
  session.abort = undefined;
  session.revision++;
}

export function beginRequest(session: TranslationSession, editor: HTMLElement, text: string): RequestSnapshot {
  cancelSession(session);
  session.sourceText = text;
  const abort = new AbortController();
  session.abort = abort;
  return {
    revision: session.revision,
    editor,
    text,
    signal: abort.signal,
    sourceLanguage: session.languagePair?.source,
    targetLanguage: session.languagePair?.target,
  };
}

export function isCurrentRequest(session: TranslationSession, snapshot: RequestSnapshot, readText: (editor: HTMLElement) => string): boolean {
  return !snapshot.signal.aborted
    && snapshot.revision === session.revision
    && session.editor === snapshot.editor
    && snapshot.editor.isConnected
    && readText(snapshot.editor) === snapshot.text
    && snapshot.sourceLanguage === session.languagePair?.source
    && snapshot.targetLanguage === session.languagePair?.target;
}
