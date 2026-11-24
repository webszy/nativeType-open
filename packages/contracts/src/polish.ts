export const POLISH_MODEL = '@cf/google/gemma-4-26b-a4b-it' as const;
export const POLISH_MAX_BODY_BYTES = 32_768;
export const POLISH_MAX_TEXT_LENGTH = 4_000;
export const POLISH_SHORT_DRAFT_LENGTH = 280;
export const POLISH_TIMEOUT_MS = 25_000;

export type PolishWritingContext = 'post' | 'reply' | 'quote' | 'chat';

/** Same UTF-16 character counting as the existing text limits; never truncate. */
export function polishDraftLimit(context?: string): number {
  return context === 'post' || context === 'chat' ? POLISH_MAX_TEXT_LENGTH : POLISH_SHORT_DRAFT_LENGTH;
}

export const polishRequestFields = ['source_language', 'target_language', 'original_source', 'draft'] as const;
export interface PolishRequest {
  source_language: string;
  target_language: string;
  original_source: string;
  draft: string;
  /** Omitted by older clients, which receive the conservative short-draft limit. */
  writing_context?: PolishWritingContext;
}

export const polishErrorCodes = ['MODEL_ERROR', 'EMPTY_RESPONSE', 'TIMEOUT', 'RATE_LIMITED', 'UNAUTHORIZED', 'PLUS_REQUIRED', 'INVALID_REQUEST'] as const;
export type PolishErrorCode = (typeof polishErrorCodes)[number];
export interface PolishUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  neurons?: number;
}
export interface EntityWarnings {
  mention: number;
  url: number;
  amount: number;
  version: number;
}
/** Authoritative access snapshot from license verification, never from the model. */
export interface PolishEntitlement {
  status: 'active' | 'expired' | 'revoked' | 'inactive' | 'none';
  plan: 'plus_monthly' | 'plus_7_day' | null;
  accessUntil: string | null;
}

export function isPolishEntitlement(value: unknown): value is PolishEntitlement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['active', 'expired', 'revoked', 'inactive', 'none'].includes(record.status as string)
    && (record.plan === null || record.plan === 'plus_monthly' || record.plan === 'plus_7_day')
    && (record.status !== 'active' || record.plan !== null)
    && (record.accessUntil === null || (typeof record.accessUntil === 'string'
      && Number.isFinite(Date.parse(record.accessUntil))));
}

export interface PolishSuccess {
  success: true;
  text: string;
  model: typeof POLISH_MODEL;
  elapsed_ms: number;
  request_id: string;
  finish_reason: string | null;
  usage: PolishUsage;
  entity_warnings?: EntityWarnings;
  entitlement?: PolishEntitlement;
}
export interface PolishFailure {
  success: false;
  error: PolishErrorCode;
  request_id: string;
  entitlement?: PolishEntitlement;
}
export type PolishResponse = PolishSuccess | PolishFailure;

export function isPolishRequest(value: unknown): value is PolishRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!polishRequestFields.every(field => Object.hasOwn(record, field))
    || Object.keys(record).some(field => field !== 'writing_context' && !polishRequestFields.some(required => required === field))) return false;
  if (Object.hasOwn(record, 'writing_context')
    && !['post', 'reply', 'quote', 'chat'].includes(record.writing_context as string)) return false;
  const language = (code: unknown): code is string => typeof code === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(code);
  const text = (input: unknown): input is string => typeof input === 'string' && !!input.trim();
  return language(record.source_language) && language(record.target_language)
    && record.source_language !== record.target_language && text(record.original_source) && text(record.draft)
    && record.draft.length <= polishDraftLimit(record.writing_context as PolishWritingContext | undefined);
}
