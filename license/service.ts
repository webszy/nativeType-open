import { apiEndpoint } from '../ai/config';
import { isRejectedLicenseKeyFormat, normalizeLicenseKey } from './format';
import type { LicenseInfo, LicensePlan, LicenseService } from './types';
import { LicenseVerificationError } from './types';

export { LicenseVerificationError } from './types';

export const licenseVerificationTimeoutMs = 15_000;

export function licenseVerifyEndpoint(value: unknown, mode: string): string | undefined {
  return apiEndpoint(value, mode, '/v1/license/verify');
}

function planOf(value: unknown): LicensePlan | undefined {
  if (value === 'plus_monthly') return 'monthly';
  if (value === 'plus_7_day') return '7_day_pass';
  return undefined;
}

function untilOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Verifies a key with the NativeType API. The key is a header, never a URL or page variable. */
export function createProductionLicenseService(options: {
  endpoint?: string;
  fetch?: typeof fetch;
} = {}): LicenseService {
  const endpoint = options.endpoint ?? licenseVerifyEndpoint(
    import.meta.env.WXT_POLISH_API_BASE_URL, import.meta.env.MODE,
  );
  const fetchVerify = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async validate(key: string): Promise<LicenseInfo> {
      const presented = key.trim();
      if (!endpoint || !presented) throw new LicenseVerificationError();
      if (isRejectedLicenseKeyFormat(presented)) return { status: 'invalid' };
      const headerValue = normalizeLicenseKey(presented) ?? presented;
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new LicenseVerificationError());
        }, licenseVerificationTimeoutMs);
      });
      try {
        return await Promise.race([deadline, (async (): Promise<LicenseInfo> => {
          const response = await fetchVerify(endpoint, {
            method: 'POST',
            headers: { 'x-nativetype-license': headerValue },
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: abort.signal,
          });
          if (abort.signal.aborted || (!response.ok && response.status !== 401)) {
            void response.body?.cancel().catch(() => undefined);
            throw new LicenseVerificationError();
          }
          const body: unknown = await response.json();
          abort.signal.throwIfAborted();
          if (!body || typeof body !== 'object') throw new LicenseVerificationError();
          const record = body as Record<string, unknown>;
          if (response.ok && record.keyValid === true) {
            let status: LicenseInfo['status'];
            if (record.isPlus === true && record.status === 'active') {
              status = 'active';
            } else if (record.isPlus === false && record.status === 'revoked') {
              status = 'access_revoked';
            } else if (record.isPlus === false
              && (record.status === 'expired' || record.status === 'inactive' || record.status === 'none')) {
              status = record.status;
            } else {
              throw new LicenseVerificationError();
            }
            return { status, plan: planOf(record.plan), validUntil: untilOf(record.accessUntil) };
          }
          if (record.keyValid === false && record.status === 'revoked') return { status: 'revoked' };
          if (record.keyValid === false && record.status === 'invalid') return { status: 'invalid' };
          throw new LicenseVerificationError();
        })()]);
      } catch {
        throw new LicenseVerificationError();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        abort.abort();
      }
    },
  };
}

export async function createLicenseService(): Promise<LicenseService> {
  if (import.meta.env.MODE !== 'production') {
    const { createMockLicenseService } = await import('./mock');
    return createMockLicenseService();
  }
  return createProductionLicenseService();
}
