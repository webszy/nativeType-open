/** Events the analytics API accepts. Anything else is rejected at runtime. */
export const analyticsEventTypes = [
  'translation_success',
  'replace_success',
  'translation_error',
] as const;

export type AnalyticsEventType = (typeof analyticsEventTypes)[number];

/** Own properties allowed on `POST /api/v1/events`. Extra properties are rejected. */
export const analyticsRequestFields = ['installId', 'event'] as const;

export interface AnalyticsEventRequest {
  /** UUID v4 created by the extension. The server stores only an HMAC of this value. */
  installId: string;
  event: AnalyticsEventType;
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
