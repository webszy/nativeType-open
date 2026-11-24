import { normalizeLicenseKey } from '@nativetype/contracts';
import { licenseCopy } from './copy';
import type { LicensePlan } from './types';

export { normalizeLicenseKey };

/** Format failures only. Development fixtures and other text keep the existing verify path. */
export function isRejectedLicenseKeyFormat(input: string): boolean {
  const typed = input.trim();
  if (!typed) return false;
  if (typed.length > 80) return true;
  if (normalizeLicenseKey(typed)) return false;
  if (/^NT-DEV-/i.test(typed)) return false;
  return typed.toUpperCase().replace(/[\s-]/g, '').startsWith('NT');
}

export function maskLicenseKey(licenseKey: string): string {
  const tail = Array.from(licenseKey).slice(-4).join('');
  return `•••• •••• ${tail}`;
}

export function licensePlanLabel(plan: LicensePlan | undefined): string | null {
  if (plan === 'monthly') return licenseCopy.monthly;
  if (plan === '7_day_pass') return licenseCopy.pass;
  return null;
}

export function formatValidUntil(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
