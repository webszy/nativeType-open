import type { LicensePlan, LicenseStatus, StoredLicense, StoredLicenseVerification } from './types';

export interface LicenseBackend {
  read(): Promise<unknown>;
  readRevision(): Promise<string | null>;
  write(value: StoredLicense, revision?: string): Promise<void>;
  remove(revision: string): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

export interface LicenseStore {
  load(): Promise<StoredLicense | null>;
  revision(): Promise<string | null>;
  save(record: StoredLicense, expectedRevision?: string | null): Promise<boolean>;
  updateVerification(record: StoredLicense): Promise<boolean>;
  remove(): Promise<void>;
}

const statuses: readonly LicenseStatus[] = ['active', 'invalid', 'expired', 'revoked', 'access_revoked', 'inactive', 'none'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is LicenseStatus {
  return typeof value === 'string' && statuses.includes(value as LicenseStatus);
}

function isPlan(value: unknown): value is LicensePlan {
  return value === 'monthly' || value === '7_day_pass';
}

export function normalizeStoredLicense(input: unknown): StoredLicense | null {
  if (!isRecord(input) || typeof input.licenseKey !== 'string') return null;
  const licenseKey = input.licenseKey.trim();
  if (!licenseKey) return null;
  const record: StoredLicense = { licenseKey };
  if (typeof input.lastVerifiedAt === 'string' && input.lastVerifiedAt.trim()) {
    record.lastVerifiedAt = input.lastVerifiedAt;
  }
  if (isRecord(input.lastVerification) && isStatus(input.lastVerification.status)) {
    const lastVerification: StoredLicenseVerification = { status: input.lastVerification.status };
    if (isPlan(input.lastVerification.plan)) lastVerification.plan = input.lastVerification.plan;
    if (input.lastVerification.validUntil === null || typeof input.lastVerification.validUntil === 'string') {
      lastVerification.validUntil = input.lastVerification.validUntil;
    }
    record.lastVerification = lastVerification;
  }
  return record;
}

export function createLicenseStore(backend: LicenseBackend): LicenseStore {
  return {
    async load() {
      return normalizeStoredLicense(await backend.read());
    },
    async revision() {
      return backend.withLock(() => backend.readRevision());
    },
    async save(record, expectedRevision) {
      const normalized = normalizeStoredLicense(record);
      if (!normalized) throw new Error('Couldn’t save this license.');
      return backend.withLock(async () => {
        if (expectedRevision !== undefined && await backend.readRevision() !== expectedRevision) return false;
        await backend.write(normalized, crypto.randomUUID());
        return true;
      });
    },
    async updateVerification(record) {
      const normalized = normalizeStoredLicense(record);
      if (!normalized) throw new Error('Couldn’t save this license.');
      return backend.withLock(async () => {
        const current = normalizeStoredLicense(await backend.read());
        if (current?.licenseKey !== normalized.licenseKey) return false;
        // A slow rewrite must not overwrite a more recent settings verification
        // or another tab's access snapshot for the same key.
        if (Date.parse(current.lastVerifiedAt ?? '') > Date.parse(normalized.lastVerifiedAt ?? '')) return false;
        await backend.write(normalized);
        return true;
      });
    },
    async remove() {
      await backend.withLock(() => backend.remove(crypto.randomUUID()));
    },
  };
}

export function createMemoryLicenseBackend(initial?: unknown): LicenseBackend & { current(): unknown } {
  let value = initial;
  let revision: string | null = null;
  let pending = Promise.resolve();
  return {
    read: async () => value,
    readRevision: async () => revision,
    write: async (next, nextRevision) => {
      value = next;
      if (nextRevision !== undefined) revision = nextRevision;
    },
    remove: async nextRevision => {
      value = undefined;
      revision = nextRevision;
    },
    withLock(operation) {
      const result = pending.then(operation);
      pending = result.then(() => undefined, () => undefined);
      return result;
    },
    current: () => value,
  };
}
