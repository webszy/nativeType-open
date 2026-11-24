import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../load-ts.mjs';

const { maskLicenseKey, licensePlanLabel, formatValidUntil, normalizeLicenseKey, isRejectedLicenseKeyFormat } = await loadTs('license/format.ts');

test('license keys keep only the last four characters', () => {
  assert.equal(maskLicenseKey('NT-DEV-MONTHLY'), '•••• •••• THLY');
  assert.equal(maskLicenseKey('abc'), '•••• •••• abc');
});

test('new and legacy license keys normalize separately', () => {
  const fresh = 'NT-0123-4567-89AB-CDEF-GHJK';
  const legacy = 'NT-IIII-LLLL-OOOO-AAAA-BBBB-CCCC-DDDD-EEEE';
  assert.equal(normalizeLicenseKey(`  ${fresh.toLowerCase()}  `), fresh);
  assert.equal(normalizeLicenseKey('nt-iiii-llll-oooo-0123-4567'), 'NT-1111-1111-0000-0123-4567');
  assert.equal(normalizeLicenseKey(legacy.toLowerCase()), legacy);
  assert.equal(normalizeLicenseKey('NT-1234'), null);
  assert.equal(normalizeLicenseKey('NT-UUUU-UUUU-UUUU-UUUU-UUUU'), null);
  assert.equal(isRejectedLicenseKeyFormat('NT-1234'), true);
  assert.equal(isRejectedLicenseKeyFormat('NT-DEV-MONTHLY'), false);
  assert.equal(isRejectedLicenseKeyFormat('KEY-saved'), false);
  assert.equal(isRejectedLicenseKeyFormat(fresh), false);
  assert.equal(isRejectedLicenseKeyFormat(legacy), false);
});

test('plan labels and expiry dates come from the verification result', () => {
  assert.equal(licensePlanLabel('monthly'), 'Plus Monthly');
  assert.equal(licensePlanLabel('7_day_pass'), '7-Day Pass');
  assert.equal(licensePlanLabel(undefined), null);
  assert.equal(formatValidUntil('2026-12-14T00:00:00.000Z'), 'Dec 14, 2026');
  assert.equal(formatValidUntil('2026-11-21T00:00:00.000Z'), 'Nov 21, 2026');
  assert.equal(formatValidUntil(null), null);
  assert.equal(formatValidUntil(undefined), null);
  assert.equal(formatValidUntil('not-a-date'), null);
});
