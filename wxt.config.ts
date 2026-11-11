import { defineConfig } from 'wxt';
import { analyticsEndpoint } from './analytics/config';

export default defineConfig({
  outDir: 'dist',
  // Keep the Chrome Web Store zip name stable after the workspace package rename.
  zip: {
    name: 'nativetype',
  },
  manifest: ({ mode, command }) => {
    const endpoint = analyticsEndpoint(process.env.WXT_ANALYTICS_API_BASE_URL, mode);
    if (command === 'build' && mode === 'production' && !endpoint) {
      throw new Error('Production builds require a valid HTTPS WXT_ANALYTICS_API_BASE_URL base URL.');
    }
    return {
      name: 'NativeType',
      description: 'Write in your language. Publish in another.',
      minimum_chrome_version: '138',
      // Local preferences and the optional random analytics ID. Drafts are not stored.
      permissions: ['storage'],
      host_permissions: endpoint ? [`${new URL(endpoint).origin}/*`] : [],
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
