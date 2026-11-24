/** Public endpoint only. Credentials are supplied at runtime, never by WXT environment variables. */
export function apiEndpoint(value: unknown, mode: string, suffix = ''): string | undefined {
  if (typeof value !== 'string' || !value || value !== value.trim()) return undefined;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(mode !== 'production' && url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash) return undefined;
    if (suffix) url.pathname = `${url.pathname.replace(/\/+$/, '')}${suffix}`;
    return url.href;
  } catch { return undefined; }
}

export function polishEndpoint(base: unknown, mode: string, endpoint?: string): string | undefined {
  return endpoint ? apiEndpoint(endpoint, mode) : apiEndpoint(base, mode, '/v1/polish');
}
