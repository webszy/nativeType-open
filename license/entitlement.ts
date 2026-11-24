import { normalizeStoredLicense } from './store';

export type EntitlementBadge = 'plus' | 'free' | 'unknown';

const confirmedWithoutPlus = new Set(['invalid', 'expired', 'revoked', 'access_revoked', 'inactive', 'none']);

/** Upload gate is stricter than the display badge; unverified/incomplete records fail closed. */
export function hasActivePlusLicense(input: unknown): boolean {
  const verification = normalizeStoredLicense(input)?.lastVerification;
  if (verification?.status !== 'active'
    || (verification.plan !== 'monthly' && verification.plan !== '7_day_pass')) return false;
  const until = verification.validUntil;
  return until === null || (typeof until === 'string' && Number.isFinite(Date.parse(until)) && Date.parse(until) > Date.now());
}

/**
 * Read-only view of a stored license record.
 * Active Plus, including an active 7-day pass, is Plus.
 * A confirmed non-active record, or no stored key, is Free.
 * A stored key that has not been verified, or whose active verification has
 * passed its valid-until date, stays unknown until verified again.
 */
export function entitlementBadge(input: unknown): EntitlementBadge {
  const record = normalizeStoredLicense(input);
  if (!record) return 'free';
  const status = record.lastVerification?.status;
  if (status === 'active') {
    const until = record.lastVerification?.validUntil;
    if (until != null && (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now())) return 'unknown';
    return 'plus';
  }
  if (status && confirmedWithoutPlus.has(status)) return 'free';
  return 'unknown';
}

export interface EntitlementStorage {
  read(): Promise<unknown>;
  watch(listener: (value: unknown) => void): () => void;
}

export function createEntitlementBadgeSource(storage: EntitlementStorage): {
  load(): Promise<EntitlementBadge>;
  subscribe(listener: (badge: EntitlementBadge) => void): () => void;
} {
  return {
    async load() {
      try {
        return entitlementBadge(await storage.read());
      } catch {
        return 'unknown';
      }
    },
    subscribe(listener) {
      let disposed = false;
      let revision = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      function update(value: unknown) {
        if (disposed) return;
        clearTimeout(timer);
        timer = undefined;
        listener(entitlementBadge(value));
        const verification = normalizeStoredLicense(value)?.lastVerification;
        const until = verification?.validUntil;
        const remaining = until ? Date.parse(until) - Date.now() : NaN;
        if (!disposed && verification?.status === 'active' && remaining > 0) {
          // Monthly licenses can outlive the maximum setTimeout delay.
          timer = setTimeout(() => update(value), Math.min(remaining, 2_147_483_647));
        }
      }
      const stop = storage.watch(value => {
        revision += 1;
        update(value);
      });
      const snapshot = revision;
      void storage.read().then(value => {
        if (revision === snapshot) update(value);
      }, () => {
        if (!disposed && revision === snapshot) listener('unknown');
      });
      return () => {
        disposed = true;
        clearTimeout(timer);
        stop();
      };
    },
  };
}
