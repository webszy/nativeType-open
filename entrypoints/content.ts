import { browser } from 'wxt/browser';
import { createAnalyticsClient } from '../analytics/client';
import { createPolishClient } from '../ai/client';
import { startNativeType } from '../core/controller';
import { defaultLanguagePair } from '../languages/config';
import { createTriggerDetector } from '../languages/detector';
import { createChromeEntitlementBadgeSource } from '../license/chrome-entitlement';
import { resolvePlatform } from '../platforms/registry';
import { createChromeSettingsStore } from '../settings/chrome';
import { OPEN_SETTINGS_MESSAGE } from '../settings/messages';
import { getTranslationProvider } from '../translators/registry';

export default defineContentScript({
  matches: ['https://x.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    const platform = resolvePlatform(window.location);
    if (!platform) return;
    startNativeType({
      platform,
      provider: getTranslationProvider('chrome'),
      languagePair: defaultLanguagePair,
      settings: createChromeSettingsStore(),
      detector: createTriggerDetector(),
      analytics: createAnalyticsClient(message => browser.runtime.sendMessage(message)),
      polish: createPolishClient(message => browser.runtime.sendMessage(message)),
      logoUrl: browser.runtime.getURL('/icon/128.png'),
      sparklesLoaderUrl: browser.runtime.getURL('/assets/nativetype-sparkles-loader.svg'),
      entitlement: createChromeEntitlementBadgeSource(),
      host: {
        listen: (target, type, listener) => ctx.addEventListener(target, type, listener),
        onInvalidated: listener => ctx.onInvalidated(listener),
        openSettings: async () => {
          const opened = await browser.runtime.sendMessage({ type: OPEN_SETTINGS_MESSAGE });
          if (opened !== true) throw new Error('Could not open NativeType settings');
        },
      },
    });
  },
});
