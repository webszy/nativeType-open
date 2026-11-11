import { isAnalyticsEventType, type AnalyticsEventRequest, type AnalyticsEventType } from '@nativetype/contracts';
import { normalizeSettings } from '../settings/store';

export const ANALYTICS_INSTALL_ID_KEY = 'analytics.installId';
export const ANALYTICS_TIMEOUT_MS = 4_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PENDING_REPORTS = 8;

export interface AnalyticsStorage {
  read(): Promise<{ settings: unknown; installId: unknown }>;
  writeInstallId(value: string): Promise<void>;
  removeInstallId(): Promise<void>;
  watchSettings(listener: (value: unknown, previous: unknown) => void): () => void;
}

export function createAnalyticsService(options: {
  storage: AnalyticsStorage;
  endpoint: string | undefined;
  fetch?: typeof fetch;
  randomUUID?: () => string;
}) {
  const { storage, endpoint } = options;
  const fetchEvent = options.fetch ?? globalThis.fetch.bind(globalThis);
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const active = new Set<AbortController>();
  let storageTask: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  let pendingReports = 0;
  let needsNewId = false;
  let disposed = false;
  let watching = false;
  let unwatch: (() => void) | undefined;

  // Only short storage operations are serialized. Network requests never hold this lock.
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = storageTask.then(operation);
    storageTask = next.catch(() => {});
    return next;
  }

  function abortRequests() {
    for (const controller of active) controller.abort();
  }

  async function identity(token: number): Promise<string | undefined> {
    if (disposed || token !== epoch) return;
    const state = await storage.read();
    if (disposed || token !== epoch) return;
    if (!normalizeSettings(state.settings).analytics.enabled) {
      needsNewId = true;
      abortRequests();
      await storage.removeInstallId();
      return;
    }
    let installId = state.installId;
    if (needsNewId || typeof installId !== 'string' || !UUID_V4.test(installId)) {
      installId = randomUUID();
      if (typeof installId !== 'string' || !UUID_V4.test(installId)) return;
      await storage.writeInstallId(installId);
      if (disposed || token !== epoch) return;
      needsNewId = false;
      // Consent may have changed while the ID write was in flight.
      const latest = await storage.read();
      if (disposed || token !== epoch) return;
      if (!normalizeSettings(latest.settings).analytics.enabled) {
        needsNewId = true;
        abortRequests();
        await storage.removeInstallId();
        return;
      }
    }
    return installId;
  }

  return {
    async start(): Promise<void> {
      if (disposed || unwatch) return;
      try {
        unwatch = storage.watchSettings((value, previous) => {
          const token = ++epoch;
          const enabled = normalizeSettings(value).analytics.enabled;
          if (!enabled) {
            needsNewId = true;
            abortRequests();
            // Do not skip this removal if the user immediately enables again.
            void serialize(() => storage.removeInstallId()).catch(abortRequests);
          } else {
            if (!normalizeSettings(previous).analytics.enabled) needsNewId = true;
            void serialize(() => identity(token)).catch(abortRequests);
          }
        });
        watching = true;
        await serialize(() => identity(epoch));
      } catch {
        abortRequests();
      }
    },
    async report(event: AnalyticsEventType): Promise<boolean> {
      if (disposed || !watching || !endpoint || !isAnalyticsEventType(event) || pendingReports >= MAX_PENDING_REPORTS) return false;
      const token = epoch;
      pendingReports += 1;
      try {
        const installId = await serialize(() => identity(token));
        if (!installId || disposed || token !== epoch) return false;
        const controller = new AbortController();
        active.add(controller);
        const timer = setTimeout(() => controller.abort(), ANALYTICS_TIMEOUT_MS);
        try {
          const body: AnalyticsEventRequest = { installId, event };
          const response = await fetchEvent(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
            redirect: 'error',
          });
          return response.status === 204;
        } catch {
          return false;
        } finally {
          clearTimeout(timer);
          active.delete(controller);
        }
      } catch {
        abortRequests();
        return false;
      } finally {
        pendingReports -= 1;
      }
    },
    dispose() {
      disposed = true;
      epoch += 1;
      unwatch?.();
      abortRequests();
    },
  };
}
