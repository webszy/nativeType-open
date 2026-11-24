import { browser } from 'wxt/browser';
import { createChromeLicenseStore } from '../../license/chrome';
import { mountPlusPanel } from '../../license/page';
import { createLicenseService } from '../../license/service';
import { createChromeSettingsStore } from '../../settings/chrome';
import { mountSettingsPage } from '../../settings/page';

const root = document.querySelector('main');
if (root instanceof HTMLElement) {
  void mountSettingsPage(root, createChromeSettingsStore(), browser.runtime.getURL('/icon/128.png'), browser.runtime.getManifest().version).then(() => {
    const plus = root.querySelector('#settings-plus');
    if (plus instanceof HTMLElement) {
      void createLicenseService().then(service => mountPlusPanel(plus, {
        service,
        store: createChromeLicenseStore(),
      }));
    }
  });
}
