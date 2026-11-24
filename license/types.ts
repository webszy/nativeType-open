import { licenseCopy } from './copy';

export type LicenseStatus = 'active' | 'invalid' | 'expired' | 'revoked' | 'access_revoked' | 'inactive' | 'none';
export type LicensePlan = 'monthly' | '7_day_pass';

export interface LicenseInfo {
  status: LicenseStatus;
  plan?: LicensePlan;
  validUntil?: string | null;
}

export interface StoredLicenseVerification {
  status: LicenseStatus;
  plan?: LicensePlan;
  validUntil?: string | null;
}

export interface StoredLicense {
  licenseKey: string;
  lastVerifiedAt?: string;
  lastVerification?: StoredLicenseVerification;
}

export interface LicenseService {
  validate(key: string): Promise<LicenseInfo>;
}

export class LicenseVerificationError extends Error {
  readonly code = 'network_error' as const;

  constructor() {
    super(licenseCopy.network);
    this.name = 'LicenseVerificationError';
  }
}
