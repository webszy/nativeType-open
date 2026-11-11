import { randomUUID } from 'node:crypto';
import { loadTs } from '../load-ts.mjs';
import { settle } from '../dom-fixture.mjs';

export const { createAnalyticsService, ANALYTICS_TIMEOUT_MS, ANALYTICS_INSTALL_ID_KEY } = await loadTs('analytics/background.ts');
const { getDefaultSettings } = await loadTs('settings/store.ts');
export const endpoint = 'https://analytics.test/api/v1/events';

export function settings(enabled) {
  return { ...getDefaultSettings(), analytics: { enabled } };
}

export function harness(t, options = {}) {
  const state = { settings: options.settings ?? settings(false), installId: options.installId };
  const listeners = new Set();
  const requests = [];
  let generated = 0;
  let writes = 0;
  const storage = {
    read: async () => ({ ...state }),
    writeInstallId: async id => { writes += 1; state.installId = id; },
    removeInstallId: async () => { state.installId = undefined; },
    watchSettings(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    ...options.storage,
  };
  const service = createAnalyticsService({
    storage,
    endpoint: Object.hasOwn(options, 'endpoint') ? options.endpoint : endpoint,
    randomUUID: () => { generated += 1; return randomUUID(); },
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return options.fetch ? options.fetch(url, init) : new Response(null, { status: 204 });
    },
  });
  t.after(() => service.dispose());
  return {
    service, state, requests, storage,
    generated: () => generated,
    writes: () => writes,
    async change(enabled) {
      const previous = state.settings;
      state.settings = settings(enabled);
      for (const listener of listeners) listener(state.settings, previous);
      await settle();
    },
  };
}

export function waitForAbort(_url, { signal }) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  });
}
