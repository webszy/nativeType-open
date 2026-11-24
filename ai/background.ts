import { POLISH_MAX_BODY_BYTES, POLISH_MODEL, POLISH_TIMEOUT_MS, isPolishRequest, isPolishEntitlement, polishErrorCodes,
  type PolishErrorCode, type PolishResponse } from '@nativetype/contracts';
import type { StoredLicense } from '../license/types';
import { normalizeStoredLicense } from '../license/store';
import { hasActivePlusLicense } from '../license/entitlement';

const MAX_RESPONSE_BYTES = 98_304;

/** Background owns runtime credentials and networking; drafts/results remain in request memory only. */
export function createPolishService(options: {
  endpoint: string | undefined;
  readLicense(): Promise<unknown>;
  updateLicenseVerification?(record: StoredLicense): Promise<unknown>;
  fetch?: typeof fetch;
}) {
  const active = new Map<string, { requestId: string; abort: AbortController }>();
  const fetchPolish = options.fetch ?? globalThis.fetch.bind(globalThis);
  const failure = (error: PolishErrorCode): PolishResponse => ({ success: false, error, request_id: crypto.randomUUID() });
  return {
    cancel(owner: string, requestId: string) {
      const pending = active.get(owner);
      if (pending?.requestId === requestId) pending.abort.abort();
    },
    async request(owner: string, requestId: string, input: unknown): Promise<PolishResponse> {
      if (!isPolishRequest(input) || new TextEncoder().encode(JSON.stringify(input)).byteLength > POLISH_MAX_BODY_BYTES) return failure('INVALID_REQUEST');
      const previous = active.get(owner);
      if (previous?.requestId === requestId) return failure('RATE_LIMITED');
      previous?.abort.abort();
      // Even different owners have a small bound; no queue or automatic retry.
      if (!previous && active.size >= 4) return failure('RATE_LIMITED');
      const abort = new AbortController();
      active.set(owner, { requestId, abort });
      const timer = setTimeout(() => abort.abort(), POLISH_TIMEOUT_MS + 5_000);
      let onAbort: () => void = () => {};
      const cancelled = new Promise<PolishResponse>(resolve => {
        onAbort = () => resolve(failure('TIMEOUT'));
        abort.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([cancelled, (async (): Promise<PolishResponse> => {
          if (!options.endpoint) return failure('MODEL_ERROR');
          const license = normalizeStoredLicense(await options.readLicense());
          if (!license || license.licenseKey.length > 80) return failure('UNAUTHORIZED');
          if (abort.signal.aborted) return failure('TIMEOUT');
          // Read key and access together on every click/Retry, before uploading any text.
          if (!hasActivePlusLicense(license)) return failure('PLUS_REQUIRED');
          const licenseKey = license.licenseKey;
          const verifiedAt = new Date().toISOString();
          const response = await fetchPolish(options.endpoint, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-nativetype-license': licenseKey },
            body: JSON.stringify(input), signal: abort.signal, credentials: 'omit', cache: 'no-store',
            redirect: 'error', referrerPolicy: 'no-referrer',
          });
          if (abort.signal.aborted) { void response.body?.cancel().catch(() => {}); return failure('TIMEOUT'); }
          if (!response.body) return failure('MODEL_ERROR');
          const reader = response.body.getReader();
          const cancel = () => { void reader.cancel().catch(() => {}); };
          abort.signal.addEventListener('abort', cancel, { once: true });
          let raw = '';
          let received = 0;
          const decoder = new TextDecoder('utf-8', { fatal: true });
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              received += value.byteLength;
              if (received > MAX_RESPONSE_BYTES) { cancel(); return failure('MODEL_ERROR'); }
              raw += decoder.decode(value, { stream: true });
            }
            raw += decoder.decode();
          } finally {
            abort.signal.removeEventListener('abort', cancel);
            reader.releaseLock();
          }
          if (abort.signal.aborted) return failure('TIMEOUT');
          const result = JSON.parse(raw) as PolishResponse;
          const validSuccess = response.ok && result.success === true && result.model === POLISH_MODEL
            && typeof result.text === 'string' && !!result.text.trim() && result.text.length <= 16_000;
          const validFailure = !response.ok && result.success === false && polishErrorCodes.includes(result.error);
          if ((validSuccess || validFailure) && isPolishEntitlement(result.entitlement)) {
            const access = result.entitlement;
            // Storage failure must not discard a usable rewrite. The store checks
            // the current key under its lock before updating the cached status.
            try {
              await options.updateLicenseVerification?.({
                licenseKey, lastVerifiedAt: verifiedAt,
                lastVerification: {
                  status: access.status === 'revoked' ? 'access_revoked' : access.status,
                  ...(access.plan ? { plan: access.plan === 'plus_monthly' ? 'monthly' : '7_day_pass' } : {}),
                  validUntil: access.accessUntil,
                },
              });
            } catch { /* A later verification can refresh the display cache. */ }
          }
          if (abort.signal.aborted) return failure('TIMEOUT');
          if (response.ok && result.success === true && result.model === POLISH_MODEL && typeof result.text === 'string'
            && result.text.trim() && result.text.length <= 16_000) return result;
          if (result.success === false && polishErrorCodes.includes(result.error)) return failure(result.error);
          if (response.status === 401) return failure('UNAUTHORIZED');
          if (response.status === 403) return failure('PLUS_REQUIRED');
          return failure(response.status === 429 ? 'RATE_LIMITED' : 'MODEL_ERROR');
        })()]);
      } catch {
        return failure(abort.signal.aborted ? 'TIMEOUT' : 'MODEL_ERROR');
      } finally {
        clearTimeout(timer);
        abort.signal.removeEventListener('abort', onAbort);
        if (active.get(owner)?.abort === abort) active.delete(owner);
      }
    },
  };
}
