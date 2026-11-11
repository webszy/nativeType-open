import { languageEnglishName } from './catalog';

export type LanguageCode = string;

export interface LanguagePair {
  source: LanguageCode;
  target: LanguageCode;
}

export const defaultLanguagePair: LanguagePair = {
  source: 'zh',
  target: 'en',
};

export type TriggerDecision = 'match' | 'skip' | 'detect';

// Verified Chinese path: any Han character still schedules translation.
// Other trigger languages go to the Language Detector. Script checks here only
// decide whether detection is worth attempting; they do not identify a language.
export function classifyTrigger(text: string, source: LanguageCode): TriggerDecision {
  const meaningful = meaningfulText(text);
  if (!meaningful) return 'skip';
  if (source === 'zh') return /\p{Script=Han}/u.test(meaningful) ? 'match' : 'skip';
  if (source === 'zh-Hant') return /\p{Script=Han}/u.test(meaningful) ? 'detect' : 'skip';
  return 'detect';
}

export function isTranslatableInput(text: string, pair: LanguagePair): boolean {
  return classifyTrigger(text, pair.source) === 'match';
}

export function meaningfulText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/@[A-Za-z0-9_]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Length policy only. Latin fragments are ambiguous; non-Latin text can be a
// full phrase in a few characters, so the detector's confidence gate decides.
export function isLongEnoughToDetect(text: string): boolean {
  const meaningful = meaningfulText(text);
  const compact = meaningful.replace(/\s+/g, '');
  if (compact.length < 2) return false;
  const latin = compact.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (latin >= compact.length * 0.6) {
    if (!/\s/.test(meaningful)) return compact.length >= 12;
    return compact.length >= 8;
  }
  return compact.length >= 4;
}

const EQUIVALENT: Record<string, readonly string[]> = {
  no: ['no', 'nb', 'nn'],
  he: ['he', 'iw'],
  zh: ['zh', 'zh-hans', 'zh-cn', 'zh-sg'],
  'zh-hant': ['zh-hant', 'zh-tw', 'zh-hk', 'zh-mo'],
};

function matchesCode(actual: string, code: string): boolean {
  return actual === code || actual.startsWith(`${code}-`);
}

export function languagesMatch(detected: string, expected: string): boolean {
  const actual = detected.trim().toLowerCase();
  const wanted = expected.trim().toLowerCase();
  if (!actual || !wanted) return false;
  // "zh" is a prefix of "zh-Hant". Traditional tags belong only to zh-Hant.
  if (wanted === 'zh' && (EQUIVALENT['zh-hant'] ?? []).some(code => matchesCode(actual, code))) return false;
  const aliases = EQUIVALENT[wanted];
  if (aliases) return aliases.some(code => matchesCode(actual, code));
  if (matchesCode(actual, wanted)) return true;
  if (!wanted.includes('-')) return actual.split('-')[0] === wanted;
  return false;
}

export function describeLanguagePair(pair: LanguagePair): string {
  return `${languageEnglishName(pair.source)} → ${languageEnglishName(pair.target)}`;
}
