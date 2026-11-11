// Public hosts that must not receive development reports. They are not credentials.
// api.typewith.si is not a Worker route. It stays blocked so local builds cannot target the old host.
const productionHosts = new Set(['typewith.si', 'api.typewith.si', 'nativetype-api.cycceme.workers.dev']);

export function analyticsEndpoint(value: unknown, mode: string): string | undefined {
  if (typeof value !== 'string' || !value || value !== value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    const hostname = url.hostname.replace(/\.$/, '');
    const local = hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname === '[::1]' || /^127\./.test(hostname)
      || hostname.endsWith('.test') || hostname.endsWith('.invalid');
    if (mode === 'production' ? local : productionHosts.has(hostname)) return undefined;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/events`;
    return url.href;
  } catch {
    return undefined;
  }
}
