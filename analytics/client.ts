import { isAnalyticsEventType, type AnalyticsEventType } from '@nativetype/contracts';

export const ANALYTICS_EVENT_MESSAGE = 'analytics:event';
export type AnalyticsReporter = (event: AnalyticsEventType) => void | Promise<unknown>;

export function eventFromMessage(message: unknown): AnalyticsEventType | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const fields = Object.keys(message);
  if (fields.length !== 2 || !fields.includes('type') || !fields.includes('event')) return undefined;
  const { type, event } = message as { type: unknown; event: unknown };
  return type === ANALYTICS_EVENT_MESSAGE && typeof event === 'string' && isAnalyticsEventType(event) ? event : undefined;
}

export function createAnalyticsClient(sendMessage: (message: { type: string; event: AnalyticsEventType }) => Promise<unknown>): AnalyticsReporter {
  return event => {
    if (!isAnalyticsEventType(event)) return;
    try {
      void sendMessage({ type: ANALYTICS_EVENT_MESSAGE, event }).catch(() => {});
    } catch {
      // A stopped extension context must not affect the completed local action.
    }
  };
}
