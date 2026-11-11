import { isLongEnoughToDetect, languagesMatch, meaningfulText } from './config';

export interface DetectionCandidate {
  detectedLanguage: string;
  confidence: number;
}

export type DetectionOutcome =
  | { status: 'match' }
  | { status: 'skip' }
  | { status: 'enable'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'error'; message: string };

export interface DetectionRequest {
  signal: AbortSignal;
  activated: boolean;
  onProgress: (progress: number) => void;
}

interface DetectorInstance {
  detect(text: string, options?: { signal?: AbortSignal }): Promise<DetectionCandidate[]>;
  destroy(): void;
}

interface LanguageDetectorAPI {
  availability(): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available' | string>;
  create(options?: {
    expectedInputLanguages?: string[];
    monitor?: (monitor: { addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void }) => void;
  }): Promise<DetectorInstance>;
}

export interface TriggerDetector {
  detectionProgressText(progress: number): string;
  prepare(source: string, onProgress: (progress: number) => void): void;
  detect(text: string, source: string, request: DetectionRequest): Promise<DetectionOutcome>;
  reset(): void;
  dispose(): void;
}

const UNAVAILABLE = 'Language detection is unavailable in this browser, so NativeType will not guess the input language.';
const UNAVAILABLE_INSTALL = 'Language detection is unavailable in this Chrome installation, so NativeType will not guess the input language.';
const ENABLE_DOWNLOAD = 'Enable language detection. Chrome may download a small model the first time.';
const ENABLE_DOWNLOADING = 'Chrome is still downloading language detection. Choose Enable translation to continue.';
const DETECT_FAILED = 'Language detection failed. Try again.';
const NEEDS_GESTURE = 'Choose Enable translation to allow Chrome to initialize language detection.';
const NEEDS_CHINESE_SCRIPT_DETECTION = 'This Chrome version cannot distinguish Traditional Chinese from Simplified Chinese. Update to Chrome 151 or later, or choose Chinese as the trigger language.';

export function interpretDetection(results: DetectionCandidate[], source: string, meaningfulLength: number): 'match' | 'skip' | 'unavailable' {
  const ranked = results
    .filter(result => result && typeof result.detectedLanguage === 'string' && typeof result.confidence === 'number')
    .sort((left, right) => right.confidence - left.confidence);
  const top = ranked[0];
  if (!top) return 'skip';
  const minimum = meaningfulLength < 12 ? 0.9 : 0.75;
  if (top.confidence < minimum) return 'skip';
  const second = ranked[1];
  if (second && second.confidence >= 0.35 && top.confidence - second.confidence < 0.2) return 'skip';
  // Before Chrome 151, both Chinese scripts were reported as the generic "zh".
  if (source === 'zh-Hant' && top.detectedLanguage.trim().toLowerCase() === 'zh') return 'unavailable';
  return languagesMatch(top.detectedLanguage, source) ? 'match' : 'skip';
}

function languageDetectorApi(): LanguageDetectorAPI | null {
  const scope = globalThis as typeof globalThis & {
    LanguageDetector?: LanguageDetectorAPI;
    ai?: { languageDetector?: LanguageDetectorAPI };
  };
  return scope.LanguageDetector ?? scope.ai?.languageDetector ?? null;
}

function destroyDetector(instance: DetectorInstance | undefined): void {
  if (!instance) return;
  try {
    instance.destroy();
  } catch {
    // create() can resolve after reset() already released the same instance.
  }
}

export function createTriggerDetector(): TriggerDetector {
  let instance: DetectorInstance | undefined;
  let creating: Promise<DetectorInstance> | undefined;
  let expected: string | undefined;
  let epoch = 0;
  let disposed = false;
  const progressListeners = new Set<(progress: number) => void>();

  function expectedLanguages(source: string): string[] {
    return source === 'zh-Hant' ? ['zh-Hant', 'zh'] : [source];
  }

  function startCreate(api: LanguageDetectorAPI, source: string): void {
    if (instance || creating) return;
    const token = epoch;
    expected = source;
    const pending = api.create({
      expectedInputLanguages: expectedLanguages(source),
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', ({ loaded }) => {
          const progress = Math.round(Math.max(0, Math.min(1, loaded)) * 100);
          for (const listener of progressListeners) listener(progress);
        });
      },
    }).then(created => {
      if (disposed || token !== epoch) {
        destroyDetector(created);
        throw new DOMException('Disposed', 'AbortError');
      }
      instance = created;
      return created;
    });
    creating = pending;
    void pending.finally(() => {
      if (creating === pending) creating = undefined;
    }).catch(() => {});
  }

  function failure(error: unknown): DetectionOutcome {
    if (error instanceof DOMException && error.name === 'AbortError') return { status: 'skip' };
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError') return { status: 'enable', message: NEEDS_GESTURE };
    if (name === 'NotSupportedError') return { status: 'unavailable', message: UNAVAILABLE_INSTALL };
    console.debug('[NativeType] Language detection failed:', name || 'Unknown error');
    return { status: 'error', message: DETECT_FAILED };
  }

  return {
    detectionProgressText: progress => `Downloading language detection… ${progress}%`,
    prepare(source, onProgress) {
      if (disposed) return;
      if (expected && expected !== source) {
        epoch += 1;
        destroyDetector(instance);
        instance = undefined;
        creating = undefined;
      }
      progressListeners.add(onProgress);
      const api = languageDetectorApi();
      if (!api) return;
      try {
        startCreate(api, source);
      } catch {
        // detect() reports the failure with a user-visible status.
      }
    },
    async detect(text, source, request) {
      const meaningful = meaningfulText(text);
      if (!isLongEnoughToDetect(text)) return { status: 'skip' };
      if (expected && expected !== source) {
        epoch += 1;
        destroyDetector(instance);
        instance = undefined;
        creating = undefined;
      }
      expected = source;
      progressListeners.add(request.onProgress);
      try {
        if (request.signal.aborted || disposed) return { status: 'skip' };
        const api = languageDetectorApi();
        if (!api) return { status: 'unavailable', message: UNAVAILABLE };
        if (!instance && !creating && !request.activated) {
          let availability: string;
          try {
            availability = await api.availability();
          } catch (error) {
            return failure(error);
          }
          if (request.signal.aborted || disposed) return { status: 'skip' };
          if (availability === 'unavailable') return { status: 'unavailable', message: UNAVAILABLE_INSTALL };
          if (availability === 'downloadable') return { status: 'enable', message: ENABLE_DOWNLOAD };
          if (availability === 'downloading') return { status: 'enable', message: ENABLE_DOWNLOADING };
          if (availability !== 'available') return { status: 'unavailable', message: UNAVAILABLE_INSTALL };
        }
        if (!instance && !creating) {
          try {
            startCreate(api, source);
          } catch (error) {
            return failure(error);
          }
        }
        const detector = instance ?? await creating;
        if (!detector) return { status: 'error', message: DETECT_FAILED };
        request.signal.throwIfAborted();
        const results = await detector.detect(meaningful, { signal: request.signal });
        request.signal.throwIfAborted();
        const status = interpretDetection(results, source, meaningful.length);
        return status === 'unavailable'
          ? { status, message: NEEDS_CHINESE_SCRIPT_DETECTION }
          : { status };
      } catch (error) {
        if (request.signal.aborted || disposed) return { status: 'skip' };
        return failure(error);
      } finally {
        progressListeners.delete(request.onProgress);
      }
    },
    reset() {
      epoch += 1;
      expected = undefined;
      destroyDetector(instance);
      instance = undefined;
      creating = undefined;
    },
    dispose() {
      disposed = true;
      this.reset();
      progressListeners.clear();
    },
  };
}
