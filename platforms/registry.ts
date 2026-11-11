import type { PlatformAdapter } from './types';
import { xPlatform } from './x';

const platforms: PlatformAdapter[] = [xPlatform];

export function resolvePlatform(location: Location): PlatformAdapter | null {
  return platforms.find(platform => platform.matches(location)) ?? null;
}
