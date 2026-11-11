import { browser } from 'wxt/browser';
import { createChromeSettingsStore } from '../../settings/chrome';
import { mountSettingsPage } from '../../settings/page';

const root = document.querySelector('main');
if (root instanceof HTMLElement) {
  void mountSettingsPage(root, createChromeSettingsStore(), browser.runtime.getURL('/icon/128.png'));
}
