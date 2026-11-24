import { POLISH_TIMEOUT_MS, polishErrorCodes, type PolishErrorCode, type PolishRequest, type PolishResponse, type PolishSuccess } from '@nativetype/contracts';

export const POLISH_REQUEST_MESSAGE = 'ai:polish';
export const POLISH_CANCEL_MESSAGE = 'ai:cancel';
export type PolishProvider = (input: PolishRequest, signal: AbortSignal) => Promise<PolishSuccess>;
export const polishErrorMessages: Record<PolishErrorCode, string> = {
  MODEL_ERROR: 'AI Improve is unavailable. Check the self-test setup or retry.',
  EMPTY_RESPONSE: 'AI returned no text. Please retry.',
  TIMEOUT: 'AI Improve timed out. Please retry.',
  RATE_LIMITED: 'Too many AI requests. Wait a minute, then retry.',
  UNAUTHORIZED: 'Enter a valid license key in NativeType Plus settings, then retry.',
  PLUS_REQUIRED: 'Activate or refresh a valid NativeType Plus license in settings, then retry.',
  INVALID_REQUEST: 'This request cannot be improved. Check the text size and language settings, then retry.',
};
export class PolishError extends Error {
  constructor(readonly code: PolishErrorCode) { super(polishErrorMessages[code]); }
}

export function createPolishClient(send: (message: object) => Promise<unknown>): PolishProvider {
  return (input, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const requestId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    const sendCancellation = () => {
      try { void send({ type: POLISH_CANCEL_MESSAGE, requestId }).catch(() => {}); } catch { /* Context closed. */ }
    };
    const cancel = () => {
      sendCancellation();
      cleanup();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    timer = setTimeout(() => { sendCancellation(); cleanup(); reject(new PolishError('TIMEOUT')); }, POLISH_TIMEOUT_MS + 6_000);
    signal.addEventListener('abort', cancel, { once: true });
    // sendMessage replies contain only the public, sanitized Worker response.
    Promise.resolve().then(() => {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      return send({ type: POLISH_REQUEST_MESSAGE, requestId, input });
    }).then(value => {
      if (signal.aborted) return;
      const response = value as PolishResponse | undefined;
      if (response?.success === true && typeof response.text === 'string' && response.text.trim()) resolve(response);
      else throw new PolishError(response?.success === false && polishErrorCodes.includes(response.error) ? response.error : 'MODEL_ERROR');
    }).catch(error => reject(error instanceof PolishError || error?.name === 'AbortError' ? error : new PolishError('MODEL_ERROR')))
      .finally(cleanup);
  });
}
