import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTs } from '../load-ts.mjs';

const { analyticsEndpoint } = await loadTs('analytics/config.ts');

test('analytics configuration requires a clean HTTPS base URL', () => {
  for (const value of [undefined, '', 'no URL', 'http://localhost:8787', 'https://user:secret@api.test',
    'https://api.test/api?text=draft', 'https://api.test/api#fragment', ' https://api.test']) {
    assert.equal(analyticsEndpoint(value, 'development'), undefined, String(value));
  }
  assert.equal(analyticsEndpoint('https://localhost:8787', 'development'), 'https://localhost:8787/v1/events');
});

test('analytics endpoints preserve the base path with or without a trailing slash', () => {
  for (const base of ['https://analytics.test/api', 'https://analytics.test/api/']) {
    assert.equal(analyticsEndpoint(base, 'development'), 'https://analytics.test/api/v1/events');
  }
  assert.equal(analyticsEndpoint('https://analytics.test/nativetype/api', 'development'),
    'https://analytics.test/nativetype/api/v1/events');
});

test('development and tests reject known production hosts and have no fallback', () => {
  for (const mode of ['development', 'test']) {
    for (const host of ['typewith.si', 'TYPEWITH.SI', 'typewith.si.', 'api.typewith.si', 'api.typewith.si.', 'nativetype-api.cycceme.workers.dev']) {
      for (const path of ['', '/api', '/api/']) {
        assert.equal(analyticsEndpoint(`https://${host}${path}`, mode), undefined);
      }
    }
    assert.equal(analyticsEndpoint(undefined, mode), undefined);
  }
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'api.test']) {
    assert.equal(analyticsEndpoint(`https://${host}`, 'production'), undefined);
  }
  for (const base of ['https://typewith.si/api', 'https://typewith.si/api/']) {
    assert.equal(analyticsEndpoint(base, 'production'), 'https://typewith.si/api/v1/events');
  }
});

test('production environment resolves to the website API endpoint', async () => {
  const env = await readFile(new URL('../../.env.production', import.meta.url), 'utf8');
  const base = env.match(/^WXT_ANALYTICS_API_BASE_URL=(.+)$/m)?.[1];
  assert.equal(base, 'https://typewith.si/api');
  assert.equal(analyticsEndpoint(base, 'production'), 'https://typewith.si/api/v1/events');
});
