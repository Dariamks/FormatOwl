import { defineRouting } from 'next-intl/routing';
import { locales } from './registry';
export const routing = defineRouting({
  locales,
  defaultLocale: 'en',
  localeDetection: false,
  alternateLinks: false,
});
