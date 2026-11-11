import { describeLanguagePair } from '../languages/config';
import { TranslationError, type TranslationProvider, type TranslationRequest } from './types';

interface TranslatorInstance {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}
interface TranslatorAPI {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available' | string>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: { addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void }) => void;
  }): Promise<TranslatorInstance>;
}

interface PairState {
  instance?: TranslatorInstance;
  creating?: Promise<TranslatorInstance>;
  progressListeners: Set<(progress: number) => void>;
}

const TRANSLATION_TIMEOUT_MS = 30_000;

function destroyTranslator(instance: TranslatorInstance | undefined): void {
  if (!instance) return;
  try {
    instance.destroy();
  } catch {
    // retainPair() and an in-flight create() can release the same instance.
  }
}

export function createChromeTranslationProvider(): TranslationProvider {
  const pairs = new Map<string, PairState>();
  let disposed = false;

  function api(): TranslatorAPI {
    const translator = (globalThis as typeof globalThis & { Translator?: TranslatorAPI }).Translator;
    if (!translator) throw new TranslationError('unsupported', 'Chrome Translator is unavailable. Use the latest desktop Chrome.');
    return translator;
  }

  function pairKey(source: string, target: string): string {
    return JSON.stringify([source, target]);
  }

  function pairFor(source: string, target: string): PairState {
    const key = pairKey(source, target);
    let pair = pairs.get(key);
    if (!pair) {
      pair = { progressListeners: new Set() };
      pairs.set(key, pair);
    }
    return pair;
  }

  function beginCreate(pair: PairState, source: string, target: string, translator: TranslatorAPI): void {
    if (pair.instance || pair.creating) return;
    const key = pairKey(source, target);
    const pending = translator.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', ({ loaded }) => {
          const progress = Math.round(Math.max(0, Math.min(1, loaded)) * 100);
          for (const listener of pair.progressListeners) listener(progress);
        });
      },
    }).then(result => {
      if (disposed || !pairs.has(key)) {
        destroyTranslator(result);
        throw new DOMException('Disposed', 'AbortError');
      }
      pair.instance = result;
      return result;
    });
    pair.creating = pending;
    // The caller awaits this promise. The housekeeping chain must not reject on its own.
    void pending.finally(() => {
      if (pair.creating === pending) pair.creating = undefined;
    }).catch(() => {});
  }

  async function ready(request: TranslationRequest, pair: PairState): Promise<TranslatorInstance> {
    if (disposed) throw new DOMException('Disposed', 'AbortError');
    if (pair.instance) return pair.instance;
    const translator = api();
    const languages = { sourceLanguage: request.source, targetLanguage: request.target };
    // The explicit button path calls create before awaiting, preserving user activation.
    if (!request.activated && !pair.creating) {
      const availability = await translator.availability(languages);
      if (disposed) throw new DOMException('Disposed', 'AbortError');
      if (availability === 'unavailable') {
        throw new TranslationError('unsupported', `${describeLanguagePair(request)} translation is unavailable in this Chrome installation.`);
      }
      if (availability === 'downloading') {
        throw new TranslationError('enable', 'Chrome is still downloading this language pack. Choose Enable translation to continue.');
      }
      if (availability === 'downloadable') {
        throw new TranslationError('enable', 'Enable Chrome translation. Chrome may download a language pack the first time.');
      }
      if (availability !== 'available') {
        throw new TranslationError('unsupported', `${describeLanguagePair(request)} translation is unavailable in this Chrome installation.`);
      }
      if (pair.instance) return pair.instance;
    }
    if (!pair.creating) beginCreate(pair, request.source, request.target, translator);
    const created = await pair.creating;
    if (!created) throw new TranslationError('error', 'Translation failed. Please retry.');
    return pair.instance ?? created;
  }

  return {
    id: 'chrome',
    downloadProgressText: progress => `Downloading Chrome language model… ${progress}%`,
    prepare(source, target) {
      if (disposed) return;
      const translator = (globalThis as typeof globalThis & { Translator?: TranslatorAPI }).Translator;
      if (!translator) return;
      try {
        beginCreate(pairFor(source, target), source, target, translator);
      } catch {
        // translate() reports a missing API after the click returns to the caller.
      }
    },
    retainPair(source, target) {
      const keep = pairKey(source, target);
      for (const [key, pair] of [...pairs]) {
        if (key === keep) continue;
        pairs.delete(key);
        pair.progressListeners.clear();
        destroyTranslator(pair.instance);
        pair.instance = undefined;
        const pending = pair.creating;
        pair.creating = undefined;
        if (pending) void pending.then(created => destroyTranslator(created)).catch(() => {});
      }
    },
    async translate(text, request) {
      if (disposed) throw new DOMException('Disposed', 'AbortError');
      const pair = pairFor(request.source, request.target);
      pair.progressListeners.add(request.onProgress);
      try {
        if (request.activated) {
          const translator = (globalThis as typeof globalThis & { Translator?: TranslatorAPI }).Translator;
          if (translator) beginCreate(pair, request.source, request.target, translator);
        }
        const translator = await ready(request, pair);
        request.signal.throwIfAborted();
        const timeout = AbortSignal.timeout(TRANSLATION_TIMEOUT_MS);
        const signal = AbortSignal.any([request.signal, timeout]);
        let result: string;
        try {
          result = await translator.translate(text, { signal });
        } catch (error) {
          if (request.signal.aborted) throw error;
          if (timeout.aborted || (error instanceof DOMException && error.name === 'TimeoutError')) {
            throw new TranslationError('error', 'Translation timed out. Check Chrome’s language-pack download and connection, then retry.');
          }
          throw error;
        }
        request.signal.throwIfAborted();
        if (!result.trim()) throw new TranslationError('error', 'Chrome returned an empty translation. Try again.');
        return result;
      } catch (error) {
        if (request.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
        if (error instanceof TranslationError) throw error;
        const name = error instanceof Error ? error.name : '';
        if (name === 'NotAllowedError') {
          throw new TranslationError('enable', 'Click Enable translation to allow Chrome to initialize its translator.');
        }
        if (name === 'NotSupportedError') {
          throw new TranslationError('unsupported', `${describeLanguagePair(request)} translation is not supported by this Chrome installation.`);
        }
        if (name === 'TimeoutError') {
          throw new TranslationError('error', 'Translation timed out. Check Chrome’s language-pack download and connection, then retry.');
        }
        // Do not log the error payload: it may contain the user's text.
        console.debug('[NativeType] Translator failed:', name || 'Unknown error');
        throw new TranslationError('error', 'Translation failed. Check Chrome’s language-pack download and connection, then retry.');
      } finally {
        pair.progressListeners.delete(request.onProgress);
      }
    },
    dispose() {
      disposed = true;
      for (const pair of pairs.values()) {
        destroyTranslator(pair.instance);
        pair.progressListeners.clear();
        const pending = pair.creating;
        if (pending) void pending.then(created => destroyTranslator(created)).catch(() => {});
      }
      pairs.clear();
    },
  };
}
