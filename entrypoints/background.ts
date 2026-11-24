import { OPEN_SETTINGS_MESSAGE } from '../settings/messages';
import { SETTINGS_STORAGE_KEY } from '../settings/keys';
import { ANALYTICS_EVENT_MESSAGE, eventFromMessage } from '../analytics/client';
import { ANALYTICS_INSTALL_ID_KEY, createAnalyticsService } from '../analytics/background';
import { analyticsEndpoint } from '../analytics/config';
import { createPolishService } from '../ai/background';
import { polishEndpoint } from '../ai/config';
import { createChromeLicenseStore } from '../license/chrome';
import { POLISH_REQUEST_MESSAGE, POLISH_CANCEL_MESSAGE } from '../ai/client';

export default defineBackground(() => {
  const licenseStore = createChromeLicenseStore();
  const polish = createPolishService({
    endpoint: polishEndpoint(import.meta.env.WXT_POLISH_API_BASE_URL, import.meta.env.MODE, import.meta.env.WXT_POLISH_API_URL),
    readLicense: () => licenseStore.load(),
    updateLicenseVerification: record => licenseStore.updateVerification(record),
  });
  const analytics = createAnalyticsService({
    endpoint: analyticsEndpoint(import.meta.env.WXT_ANALYTICS_API_BASE_URL, import.meta.env.MODE),
    storage: {
      async read() {
        const stored = await browser.storage.local.get([SETTINGS_STORAGE_KEY, ANALYTICS_INSTALL_ID_KEY]);
        return { settings: stored[SETTINGS_STORAGE_KEY], installId: stored[ANALYTICS_INSTALL_ID_KEY] };
      },
      async writeInstallId(value) {
        await browser.storage.local.set({ [ANALYTICS_INSTALL_ID_KEY]: value });
      },
      async removeInstallId() {
        await browser.storage.local.remove(ANALYTICS_INSTALL_ID_KEY);
      },
      watchSettings(listener) {
        const changed: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
          if (area !== 'local' || !Object.prototype.hasOwnProperty.call(changes, SETTINGS_STORAGE_KEY)) return;
          const change = changes[SETTINGS_STORAGE_KEY];
          listener(change?.newValue, change?.oldValue);
        };
        browser.storage.onChanged.addListener(changed);
        return () => browser.storage.onChanged.removeListener(changed);
      },
    },
  });
  void analytics.start();
  browser.action.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage();
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === POLISH_REQUEST_MESSAGE || message?.type === POLISH_CANCEL_MESSAGE) {
      if (sender.id !== browser.runtime.id || sender.tab?.id === undefined || sender.frameId !== 0
        || !sender.url?.startsWith('https://x.com/') || typeof message.requestId !== 'string'
        || !/^[0-9a-f-]{36}$/i.test(message.requestId)) { sendResponse(false); return; }
      const owner = `${sender.tab.id}:${sender.frameId}:${sender.documentId ?? ''}`;
      if (message.type === POLISH_CANCEL_MESSAGE) { polish.cancel(owner, message.requestId); sendResponse(true); return; }
      void polish.request(owner, message.requestId, message.input).then(result => {
        try { sendResponse(result); } catch { /* Tab closed. */ }
      }, () => { try { sendResponse(false); } catch { /* Tab closed. */ } });
      return true;
    }
    if (message?.type === ANALYTICS_EVENT_MESSAGE) {
      const reply = (value: boolean) => {
        try { sendResponse(value); } catch { /* The sending tab may have closed. */ }
      };
      const event = eventFromMessage(message);
      if (!event || sender.id !== browser.runtime.id) {
        reply(false);
        return;
      }
      void analytics.report(event).then(reply, () => reply(false));
      return true;
    }
    if (message?.type !== OPEN_SETTINGS_MESSAGE) return;
    void browser.runtime.openOptionsPage().then(
      () => sendResponse(true),
      () => sendResponse(false),
    );
    // Keep asynchronous replies compatible with the minimum Chrome version.
    return true;
  });
});
