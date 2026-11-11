import { canonicalLanguage } from '../languages/catalog';
import { defaultLanguagePair } from '../languages/config';
import { platformContextConfig, type ContextSettings } from './config';

export interface NativeTypeSettings {
  schemaVersion: 1;
  translation: {
    sourceLanguage: string;
    targetLanguage: string;
  };
  contexts: ContextSettings;
  analytics: { enabled: boolean };
}

export interface SettingsBackend {
  read(): Promise<unknown>;
  write(value: NativeTypeSettings): Promise<void>;
  watch(listener: (value: unknown) => void): () => void;
}

export interface SettingsStore {
  load(): Promise<NativeTypeSettings>;
  save(settings: NativeTypeSettings): Promise<void>;
  subscribe(listener: (settings: NativeTypeSettings) => void): () => void;
}

export function getDefaultSettings(): NativeTypeSettings {
  return {
    schemaVersion: 1,
    translation: {
      sourceLanguage: defaultLanguagePair.source,
      targetLanguage: defaultLanguagePair.target,
    },
    contexts: normalizeContexts(undefined),
    analytics: { enabled: false },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeContexts(input: unknown): ContextSettings {
  const stored = isRecord(input) ? input : {};
  return Object.fromEntries(Object.entries(platformContextConfig).map(([platform, config]) => {
    const values = isRecord(stored[platform]) ? stored[platform] : {};
    return [platform, Object.fromEntries(Object.entries(config.contexts).map(([context, option]) => [
      context,
      typeof values[context] === 'boolean' ? values[context] : option.defaultEnabled,
    ]))];
  })) as ContextSettings;
}

function differentTarget(source: string): string {
  return source === 'en' ? 'zh' : 'en';
}

export function normalizeSettings(input: unknown): NativeTypeSettings {
  const defaults = getDefaultSettings();
  const record = isRecord(input) ? input : {};
  const translation = isRecord(record.translation) ? record.translation : {};
  const analytics = isRecord(record.analytics) ? record.analytics : {};
  let sourceLanguage = canonicalLanguage(translation.sourceLanguage) ?? defaults.translation.sourceLanguage;
  let targetLanguage = canonicalLanguage(translation.targetLanguage) ?? defaults.translation.targetLanguage;
  if (sourceLanguage === targetLanguage) targetLanguage = differentTarget(sourceLanguage);
  return {
    schemaVersion: 1,
    translation: { sourceLanguage, targetLanguage },
    contexts: normalizeContexts(record.contexts),
    analytics: { enabled: record.schemaVersion === 1 && analytics.enabled === true },
  };
}

export function sameSettings(left: NativeTypeSettings, right: NativeTypeSettings): boolean {
  const leftContexts: Record<string, Record<string, boolean>> = left.contexts;
  const rightContexts: Record<string, Record<string, boolean>> = right.contexts;
  return left.translation.sourceLanguage === right.translation.sourceLanguage
    && left.translation.targetLanguage === right.translation.targetLanguage
    && left.analytics.enabled === right.analytics.enabled
    && Object.entries(platformContextConfig).every(([platform, config]) =>
      Object.entries(config.contexts).every(([context, option]) =>
        (leftContexts[platform]?.[context] ?? option.defaultEnabled) === (rightContexts[platform]?.[context] ?? option.defaultEnabled)));
}

export function createSettingsStore(backend: SettingsBackend): SettingsStore {
  return {
    async load() {
      return normalizeSettings(await backend.read());
    },
    async save(settings) {
      await backend.write(normalizeSettings(settings));
    },
    subscribe(listener) {
      return backend.watch(value => listener(normalizeSettings(value)));
    },
  };
}

export function createMemoryBackend(initial?: unknown): SettingsBackend & { current(): unknown } {
  let value = initial;
  const listeners = new Set<(value: unknown) => void>();
  return {
    read: async () => value,
    write: async next => {
      value = next;
      for (const listener of listeners) listener(value);
    },
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current: () => value,
  };
}
