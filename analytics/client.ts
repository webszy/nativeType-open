import { isAnalyticsEventPayload, type AnalyticsEventContext, type AnalyticsEventPayload, type AnalyticsEventType } from '@nativetype/contracts';

export const ANALYTICS_EVENT_MESSAGE = 'analytics:event';
export type AnalyticsReporter = (event: AnalyticsEventType, context?: AnalyticsEventContext) => void | Promise<unknown>;

export function eventFromMessage(message: unknown): AnalyticsEventPayload | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const { type, ...payload } = message as Record<string, unknown>;
  return type === ANALYTICS_EVENT_MESSAGE && isAnalyticsEventPayload(payload) ? payload : undefined;
}

export function createAnalyticsClient(sendMessage: (message: AnalyticsEventPayload & { type: string }) => Promise<unknown>): AnalyticsReporter {
  return (event, context) => {
    try {
      const payload = { event, ...context };
      if (!isAnalyticsEventPayload(payload)) return;
      // Preserve eventId through transport; a retry of this payload keeps its ID.
      void sendMessage({ type: ANALYTICS_EVENT_MESSAGE, ...payload }).catch(() => {});
    } catch {
      // A stopped extension context must not affect the completed local action.
    }
  };
}
