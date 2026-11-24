/** Events the analytics API accepts. Anything else is rejected at runtime. */
export const analyticsEventTypes = [
  'analytics_enabled',
  'translation_success',
  'replace_success',
  'translation_error',
  'ai_improve_replaced',
  'composer_session_started',
  'preview_shown',
  'improve_with_ai_shown',
  'improve_with_ai_clicked',
  'ai_rewrite_success',
  'ai_rewrite_error',
  'preview_dismissed',
] as const;

export type AnalyticsEventType = (typeof analyticsEventTypes)[number];

export type AnalyticsSource = 'local' | 'ai';
export type AnalyticsMode = 'manual' | 'automatic';

/** Content-free usage context. The consent event has no session or preview. */
export interface AnalyticsEventContext {
  eventId?: string;
  sessionId?: string;
  previewId?: string;
  source?: AnalyticsSource;
  mode?: AnalyticsMode;
}

export interface AnalyticsEventPayload extends AnalyticsEventContext {
  event: AnalyticsEventType;
}

export interface AnalyticsEventRequest extends AnalyticsEventPayload {
  /** UUID v4. Only its HMAC is stored by the server. */
  installId: string;
}

export const analyticsRequestFields = ['installId', 'event', 'eventId', 'sessionId', 'previewId', 'source', 'mode'] as const;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const legacyEvents = new Set(['translation_success', 'translation_error', 'replace_success', 'ai_improve_replaced']);

/** Shared fail-closed validation for runtime messages and the public endpoint. */
export function isAnalyticsEventPayload(value: unknown): value is AnalyticsEventPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data);
  if (keys.some(key => key === 'installId' || !(analyticsRequestFields as readonly string[]).includes(key))) return false;
  if (typeof data.event !== 'string' || !isAnalyticsEventType(data.event)) return false;
  if (data.event === 'analytics_enabled') return keys.length === 1;
  if (keys.length === 1) return legacyEvents.has(data.event);
  if (data.event === 'ai_improve_replaced') return false;
  if (typeof data.eventId !== 'string' || !uuidV4.test(data.eventId)
    || typeof data.sessionId !== 'string' || !uuidV4.test(data.sessionId)) return false;
  const translation = data.event === 'translation_success' || data.event === 'translation_error';
  const preview = !translation && data.event !== 'composer_session_started';
  const sourced = ['preview_shown', 'replace_success', 'preview_dismissed'].includes(data.event);
  if (preview ? typeof data.previewId !== 'string' || !uuidV4.test(data.previewId) : 'previewId' in data) return false;
  if (sourced ? data.source !== 'local' && data.source !== 'ai' : 'source' in data) return false;
  // mode is required on local translation; optional on other modern events.
  if (translation || 'mode' in data) {
    if (data.mode !== 'manual' && data.mode !== 'automatic') return false;
  }
  return true;
}

export function parseAnalyticsEventRequest(value: unknown): AnalyticsEventRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return;
  const { installId, ...payload } = value as Record<string, unknown>;
  if (typeof installId !== 'string' || !uuidV4.test(installId) || !isAnalyticsEventPayload(payload)) return;
  return {
    ...payload,
    installId: installId.toLowerCase(),
    ...(payload.eventId ? { eventId: payload.eventId.toLowerCase() } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId.toLowerCase() } : {}),
    ...(payload.previewId ? { previewId: payload.previewId.toLowerCase() } : {}),
  };
}

export const analyticsErrorCodes = [
  'invalid_json',
  'invalid_request',
  'unsupported_media_type',
  'payload_too_large',
  'method_not_allowed',
  'forbidden',
  'rate_limited',
  'unavailable',
  'not_found',
] as const;

export type AnalyticsErrorCode = (typeof analyticsErrorCodes)[number];

/** Error body. It never includes the install id, hash, or request payload. */
export interface AnalyticsErrorBody {
  error: AnalyticsErrorCode;
}

export function isAnalyticsEventType(value: string): value is AnalyticsEventType {
  return (analyticsEventTypes as readonly string[]).includes(value);
}
