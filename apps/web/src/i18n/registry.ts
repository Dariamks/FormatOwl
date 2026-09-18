/** URL codes are stable public identifiers. Keep /zh for existing Simplified Chinese links. */
export const localeRegistry = {
  en: { name: 'English', lang: 'en', dir: 'ltr', og: 'en_US' },
  ru: { name: 'Русский', lang: 'ru', dir: 'ltr', og: 'ru_RU' },
  zh: { name: '简体中文', lang: 'zh-Hans', dir: 'ltr', og: 'zh_CN' },
  'zh-Hant': { name: '繁體中文', lang: 'zh-Hant', dir: 'ltr', og: 'zh_TW' },
  tr: { name: 'Türkçe', lang: 'tr', dir: 'ltr', og: 'tr_TR' },
  id: { name: 'Bahasa Indonesia', lang: 'id', dir: 'ltr', og: 'id_ID' },
  hi: { name: 'हिन्दी', lang: 'hi', dir: 'ltr', og: 'hi_IN' },
  ja: { name: '日本語', lang: 'ja', dir: 'ltr', og: 'ja_JP' },
  es: { name: 'Español', lang: 'es', dir: 'ltr', og: 'es_ES' },
  fr: { name: 'Français', lang: 'fr', dir: 'ltr', og: 'fr_FR' },
  ar: { name: 'العربية', lang: 'ar', dir: 'rtl', og: 'ar_SA' },
  uk: { name: 'Українська', lang: 'uk', dir: 'ltr', og: 'uk_UA' },
  ko: { name: '한국어', lang: 'ko', dir: 'ltr', og: 'ko_KR' },
  pt: { name: 'Português', lang: 'pt', dir: 'ltr', og: 'pt_PT' },
  de: { name: 'Deutsch', lang: 'de', dir: 'ltr', og: 'de_DE' },
  it: { name: 'Italiano', lang: 'it', dir: 'ltr', og: 'it_IT' },
  ms: { name: 'Bahasa Melayu', lang: 'ms', dir: 'ltr', og: 'ms_MY' },
  ur: { name: 'اردو', lang: 'ur', dir: 'rtl', og: 'ur_PK' },
  pl: { name: 'Polski', lang: 'pl', dir: 'ltr', og: 'pl_PL' },
  vi: { name: 'Tiếng Việt', lang: 'vi', dir: 'ltr', og: 'vi_VN' },
  nl: { name: 'Nederlands', lang: 'nl', dir: 'ltr', og: 'nl_NL' },
  th: { name: 'ไทย', lang: 'th', dir: 'ltr', og: 'th_TH' },
  ro: { name: 'Română', lang: 'ro', dir: 'ltr', og: 'ro_RO' },
  cs: { name: 'Čeština', lang: 'cs', dir: 'ltr', og: 'cs_CZ' },
  el: { name: 'Ελληνικά', lang: 'el', dir: 'ltr', og: 'el_GR' },
} as const;
export type Locale = keyof typeof localeRegistry;
export const locales = Object.keys(localeRegistry) as Locale[];
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(localeRegistry, value);
}
export function validLocale(value: unknown): Locale {
  return isLocale(value) ? value : 'en';
}
