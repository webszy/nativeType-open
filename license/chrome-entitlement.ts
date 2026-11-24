import { browser } from 'wxt/browser';
import { createChromeLicenseStore } from './chrome';
import { createEntitlementBadgeSource } from './entitlement';
import { LICENSE_STORAGE_KEY } from './keys';

/** Stored license status for display. Does not verify, refresh, or return the key. */
export function createChromeEntitlementBadgeSource() {
  const store = createChromeLicenseStore();
  return createEntitlementBadgeSource({
    read: () => store.load(),
    watch(listener) {
      const onChanged: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, areaName) => {
        if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, LICENSE_STORAGE_KEY)) return;
        listener(changes[LICENSE_STORAGE_KEY]?.newValue);
      };
      browser.storage.onChanged.addListener(onChanged);
      return () => browser.storage.onChanged.removeListener(onChanged);
    },
  });
}
