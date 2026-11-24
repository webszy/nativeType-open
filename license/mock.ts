import { LicenseVerificationError, type LicenseInfo, type LicenseService } from './types';

const monthlyUntil = '2026-12-14T00:00:00.000Z';
const passUntil = '2026-11-21T00:00:00.000Z';

function delay(): Promise<void> {
  if (import.meta.env.MODE !== 'development') return Promise.resolve();
  return new Promise(resolve => {
    setTimeout(resolve, 250);
  });
}

// Fixed development keys only. Any other key is invalid. This module must not be shipped in production.
export function createMockLicenseService(): LicenseService {
  return {
    async validate(key: string): Promise<LicenseInfo> {
      await delay();
      switch (key.trim()) {
        case 'NT-DEV-MONTHLY':
          return { status: 'active', plan: 'monthly', validUntil: monthlyUntil };
        case 'NT-DEV-PASS':
          return { status: 'active', plan: '7_day_pass', validUntil: passUntil };
        case 'NT-DEV-OPEN':
          return { status: 'active', plan: 'monthly', validUntil: null };
        case 'NT-DEV-INVALID':
          return { status: 'invalid' };
        case 'NT-DEV-EXPIRED':
          return { status: 'expired', plan: 'monthly', validUntil: '2026-01-01T00:00:00.000Z' };
        case 'NT-DEV-REVOKED':
          return { status: 'revoked', plan: 'monthly', validUntil: null };
        case 'NT-DEV-NETWORK':
          throw new LicenseVerificationError();
        default:
          return { status: 'invalid' };
      }
    },
  };
}
