import { browser } from 'wxt/browser';
import { createSettingsStore, type NativeTypeSettings, type SettingsStore } from './store';
import { SETTINGS_STORAGE_KEY } from './keys';
export { SETTINGS_STORAGE_KEY } from './keys';

export function createChromeSettingsStore(): SettingsStore {
  return createSettingsStore({
    async read() {
      const stored = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
      return stored[SETTINGS_STORAGE_KEY];
    },
    async write(value: NativeTypeSettings) {
      await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: value });
    },
    watch(listener) {
      const onChanged: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, areaName) => {
        if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, SETTINGS_STORAGE_KEY)) return;
        listener(changes[SETTINGS_STORAGE_KEY]?.newValue);
      };
      browser.storage.onChanged.addListener(onChanged);
      return () => browser.storage.onChanged.removeListener(onChanged);
    },
  });
}
