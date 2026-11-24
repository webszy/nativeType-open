import { browser } from 'wxt/browser';
import { LICENSE_REVISION_STORAGE_KEY, LICENSE_STORAGE_KEY } from './keys';
import { createLicenseStore, type LicenseStore } from './store';

export { LICENSE_STORAGE_KEY };

export function createChromeLicenseStore(): LicenseStore {
  return createLicenseStore({
    async read() {
      const stored = await browser.storage.local.get(LICENSE_STORAGE_KEY);
      return stored[LICENSE_STORAGE_KEY];
    },
    async readRevision() {
      const stored = await browser.storage.local.get(LICENSE_REVISION_STORAGE_KEY);
      const revision = stored[LICENSE_REVISION_STORAGE_KEY];
      return typeof revision === 'string' ? revision : null;
    },
    async write(value, revision) {
      await browser.storage.local.set({
        [LICENSE_STORAGE_KEY]: value,
        ...(revision === undefined ? {} : { [LICENSE_REVISION_STORAGE_KEY]: revision }),
      });
    },
    async remove(revision) {
      // Keep a revision after removal so an in-flight activation cannot restore the key.
      await browser.storage.local.set({ [LICENSE_STORAGE_KEY]: null, [LICENSE_REVISION_STORAGE_KEY]: revision });
    },
    async withLock(operation) {
      return navigator.locks.request('nativetype-license', () => operation());
    },
  });
}
