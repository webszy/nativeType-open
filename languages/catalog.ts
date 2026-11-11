// Chrome's Translator API language coverage, as documented at
// https://developer.chrome.com/docs/ai/translator-api
// Availability of a specific pair is still checked at translation time.
export interface TranslatorLanguage {
  code: string;
  englishName: string;
}

export const translatorLanguages: readonly TranslatorLanguage[] = [
  { code: 'ar', englishName: 'Arabic' },
  { code: 'bn', englishName: 'Bengali' },
  { code: 'bg', englishName: 'Bulgarian' },
  { code: 'zh', englishName: 'Chinese' },
  { code: 'zh-Hant', englishName: 'Chinese (Traditional)' },
  { code: 'hr', englishName: 'Croatian' },
  { code: 'cs', englishName: 'Czech' },
  { code: 'da', englishName: 'Danish' },
  { code: 'nl', englishName: 'Dutch' },
  { code: 'en', englishName: 'English' },
  { code: 'fi', englishName: 'Finnish' },
  { code: 'fr', englishName: 'French' },
  { code: 'de', englishName: 'German' },
  { code: 'el', englishName: 'Greek' },
  { code: 'he', englishName: 'Hebrew' },
  { code: 'hi', englishName: 'Hindi' },
  { code: 'hu', englishName: 'Hungarian' },
  { code: 'id', englishName: 'Indonesian' },
  { code: 'it', englishName: 'Italian' },
  { code: 'ja', englishName: 'Japanese' },
  { code: 'kn', englishName: 'Kannada' },
  { code: 'ko', englishName: 'Korean' },
  { code: 'lt', englishName: 'Lithuanian' },
  { code: 'mr', englishName: 'Marathi' },
  { code: 'no', englishName: 'Norwegian' },
  { code: 'pl', englishName: 'Polish' },
  { code: 'pt', englishName: 'Portuguese' },
  { code: 'ro', englishName: 'Romanian' },
  { code: 'ru', englishName: 'Russian' },
  { code: 'sk', englishName: 'Slovak' },
  { code: 'sl', englishName: 'Slovenian' },
  { code: 'es', englishName: 'Spanish' },
  { code: 'sv', englishName: 'Swedish' },
  { code: 'ta', englishName: 'Tamil' },
  { code: 'te', englishName: 'Telugu' },
  { code: 'th', englishName: 'Thai' },
  { code: 'tr', englishName: 'Turkish' },
  { code: 'uk', englishName: 'Ukrainian' },
  { code: 'vi', englishName: 'Vietnamese' },
];

const byCode = new Map(translatorLanguages.map(language => [language.code.toLowerCase(), language]));

export function canonicalLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return byCode.get(value.trim().toLowerCase())?.code ?? null;
}

export function languageEnglishName(code: string): string {
  return byCode.get(code.toLowerCase())?.englishName
    ?? new Intl.DisplayNames(['en'], { type: 'language' }).of(code)
    ?? code;
}

export function languageOptionLabel(code: string): string {
  const english = languageEnglishName(code);
  let native = '';
  try {
    native = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? '';
  } catch {
    native = '';
  }
  if (!native || native === code || native.toLocaleLowerCase() === english.toLocaleLowerCase()) return english;
  return `${english} — ${native}`;
}
