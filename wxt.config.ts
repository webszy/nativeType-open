import { defineConfig } from 'wxt';
import { analyticsEndpoint } from './analytics/config';
import { polishEndpoint } from './ai/config';
import { licenseVerifyEndpoint } from './license/service';

export default defineConfig({
  manifestVersion: 3,
  outDir: 'dist',
  // Keep the Chrome Web Store zip name stable after the workspace package rename.
  zip: {
    name: 'nativetype',
  },
  manifest: ({ mode, command }) => {
    const endpoint = analyticsEndpoint(process.env.WXT_ANALYTICS_API_BASE_URL, mode);
    const base = process.env.WXT_POLISH_API_BASE_URL;
    const aiEndpoint = polishEndpoint(base, mode, process.env.WXT_POLISH_API_URL);
    const licenseEndpoint = licenseVerifyEndpoint(base, mode);
    if (command === 'build' && mode === 'production' && !endpoint) {
      throw new Error('Production builds require a valid HTTPS WXT_ANALYTICS_API_BASE_URL base URL.');
    }
    if (command === 'build' && mode === 'production' && !licenseEndpoint) {
      throw new Error('Production builds require a valid HTTPS WXT_POLISH_API_BASE_URL base URL.');
    }
    if (command === 'build' && mode === 'production' && !aiEndpoint) {
      throw new Error('Production builds require a valid HTTPS AI Rewrite endpoint. Check WXT_POLISH_API_URL.');
    }
    return {
      name: 'NativeType: Inline X Translator & AI Writer',
      short_name: 'NativeType',
      description: 'Write on X in your native language and publish in another. Free local on-device translation with optional AI writing polish.',
      minimum_chrome_version: '138',
      // Local preferences and the optional random analytics ID. Drafts are not stored.
      permissions: ['storage'],
      web_accessible_resources: [{
        resources: ['icon/128.png', 'assets/nativetype-sparkles-loader.svg'],
        matches: ['https://x.com/*'],
      }],
      host_permissions: [...new Set([endpoint, aiEndpoint, licenseEndpoint].filter((value): value is string => !!value).map(value => `${new URL(value).origin}/*`))],
      action: {
        default_title: 'NativeType Settings',
        default_icon: {
          128: 'icon/128.png',
        },
      },
      icons: {
        128: 'icon/128.png',
      },
    };
  },
});
