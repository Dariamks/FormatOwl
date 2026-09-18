import { describe, it, expect } from 'vitest';
import { locales, localeRegistry, isLocale, validLocale } from '../../apps/web/src/i18n/registry';
import { toolNamespaces } from '../../apps/web/src/i18n/bundles';
import { tools } from '../../packages/core/src/catalog';
import { readFileSync } from 'node:fs';

describe('locale boundaries', () => {
  it('has distinct URL identifiers and maps both Chinese scripts explicitly', () => {
    expect(new Set(locales).size).toBe(25);
    expect(localeRegistry.zh.lang).toBe('zh-Hans');
    expect(localeRegistry['zh-Hant'].lang).toBe('zh-Hant');
    expect(locales.filter((l) => localeRegistry[l].dir === 'rtl')).toEqual(['ar', 'ur']);
    for (const value of ['constructor', '__proto__', '../en', 'zz', '', null, undefined]) {
      expect(isLocale(value)).toBe(false);
      expect(validLocale(value)).toBe('en');
    }
  });
  it('tool bundles contain only interactive messages and exist in the source catalogue', () => {
    for (const tool of tools) {
      const names = toolNamespaces(tool.id);
      expect(names).not.toContain('content');
      expect(names).not.toContain('email');
      expect(names).not.toContain('login');
      for (const name of names)
        expect(JSON.parse(readFileSync(`apps/web/messages/en/${name}.json`, 'utf8'))).toBeTruthy();
    }
    expect(toolNamespaces('image-compressor')).not.toContain('translation');
    expect(toolNamespaces('image-translator')).not.toContain('media');
  });
});
