import assert from 'node:assert/strict';
import { chromium, type Browser, type ConnectOverCDPTransport, type Page } from 'playwright';
import WebSocket from 'ws';

interface Message {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: {
    sessionId?: string;
    targetInfo?: { targetId: string; type: string };
    [key: string]: unknown;
  };
  result?: Record<string, unknown>;
  error?: { message: string };
}

// Scope Playwright to an owned tab. Its normal CDP connection initializes every
// existing tab and can hang on suspended tabs in a developer's everyday Chrome.
// All commands/results come from the real browser; no extension or page is mocked.
export async function connectCurrentChrome(endpoint: string, timeout: number): Promise<{ browser: Browser; page: Page }> {
  const deadline = Date.now() + timeout;
  if (endpoint.startsWith('http')) {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(timeout) });
    assert(response.ok, 'This Chrome does not expose /json/version. Use --connect to discover its consent-based WebSocket endpoint.');
    const version = await response.json() as { webSocketDebuggerUrl: string };
    endpoint = version.webSocketDebuggerUrl;
  }
  const address = new URL(endpoint);
  assert(['ws:', 'wss:'].includes(address.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)
    && !address.username && !address.password, 'The discovered Chrome endpoint must be a local WebSocket without credentials.');
  const socket = new WebSocket(endpoint);
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const ignoredSessions = new Set<string>();
  // Reserve positive IDs outside Playwright's ordinary sequential request IDs.
  let nextId = 1_000_000;
  let targetId: string | undefined;
  let connected = false;
  const command = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome did not answer ${method} before the connection timeout.`));
    }, Math.max(1, Math.min(30_000, deadline - Date.now())));
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ||= (async () => {
    // Playwright also closes the transport on startup failure. Remove only the
    // newly owned target before disconnecting so interrupted runs leave no tab.
    if (!connected && targetId && socket.readyState === WebSocket.OPEN) {
      await command('Target.closeTarget', { targetId }).catch(() => {});
    }
    socket.close();
  })();
  const interrupt = () => { process.exitCode = 130; void close(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const transport: ConnectOverCDPTransport = {
    send(message: object) {
      const outgoing = message as Message;
      if (!outgoing.sessionId && outgoing.method === 'Target.getTargetInfo' && !outgoing.params?.targetId) {
        // The consent-based endpoint does not always have a browser target to
        // infer here. Query our real tab explicitly for Playwright's barrier.
        outgoing.params = { ...outgoing.params, targetId };
      }
      if (!outgoing.sessionId && outgoing.method === 'Target.setAutoAttach') {
        // Do not pause or initialize unrelated user pages, extensions or workers.
        outgoing.params = { ...outgoing.params, waitForDebuggerOnStart: false,
          filter: [{ type: 'page' }, { exclude: true }] };
      }
      socket.send(JSON.stringify(outgoing));
    },
    close: () => { void close(); },
  };
  socket.on('message', data => {
    const message = JSON.parse(data.toString()) as Message;
    if (message.id !== undefined && pending.has(message.id)) {
      const callback = pending.get(message.id)!;
      pending.delete(message.id);
      clearTimeout(callback.timer);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result || {});
      return;
    }
    if (!message.sessionId && message.method === 'Target.attachedToTarget'
      // Explicit browser sessions are needed for real extension loading.
      && message.params?.targetInfo?.type !== 'browser'
      && message.params?.targetInfo?.targetId !== targetId) {
      const sessionId = message.params?.sessionId;
      if (sessionId) {
        ignoredSessions.add(sessionId);
        void command('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      return;
    }
    if (message.sessionId && ignoredSessions.has(message.sessionId)) return;
    if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId
      && ignoredSessions.delete(message.params.sessionId)) return;
    transport.onmessage?.(message);
  });
  socket.on('close', () => {
    for (const callback of pending.values()) {
      clearTimeout(callback.timer);
      callback.reject(new Error('Chrome disconnected.'));
    }
    pending.clear();
    transport.onclose?.();
  });
  socket.on('error', () => {}); // Open/close callbacks report connection failures.
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Chrome connection timed out. Approve its remote debugging dialog and retry.')); }, Math.max(1, deadline - Date.now()));
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('Could not connect to current Chrome. Check its remote debugging setting.')); });
    });
    const created = await command('Target.createTarget', { url: 'about:blank' });
    assert(typeof created.targetId === 'string');
    targetId = created.targetId;
    const browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: Math.max(1, deadline - Date.now()) });
    const pages = browser.contexts()[0]?.pages();
    assert(pages?.length === 1, 'The scoped connection must contain only its new capture tab.');
    connected = true;
    return { browser, page: pages[0]! };
  } catch (error) {
    await close();
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
