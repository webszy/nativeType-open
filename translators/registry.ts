import { createChromeTranslationProvider } from './chrome';
import type { TranslationProvider } from './types';

const providers = {
  chrome: createChromeTranslationProvider,
};

export function getTranslationProvider(id: keyof typeof providers): TranslationProvider {
  return providers[id]();
}
