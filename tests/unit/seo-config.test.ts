import { describe, expect, it } from 'vitest';
import { seoConfig } from '../../apps/web/src/lib/seo-config';
describe('SEO launch configuration', () => {
  it('defaults to no indexing and a local origin', () => {
    expect(seoConfig({})).toEqual({ indexable: false, origin: 'http://127.0.0.1:3000' });
    expect(seoConfig({ APP_URL: 'https://seo.example.com/' }).indexable).toBe(false);
  });
  it('requires an explicit flag and a public HTTPS origin', () => {
    expect(seoConfig({ APP_URL: 'https://seo.example.com/', SEO_INDEXABLE: 'true' })).toEqual({
      indexable: true,
      origin: 'https://seo.example.com',
    });
    for (const APP_URL of [
      undefined,
      'http://example.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://site.local',
      'https://site.test',
      'https://user:pass@example.com',
      'https://example.com/path',
      'https://example.com/?x=1',
      'https://example.com/#test',
    ])
      expect(() => seoConfig({ APP_URL, SEO_INDEXABLE: 'true' })).toThrow();
    expect(() => seoConfig({ APP_URL: 'https://example.com', SEO_INDEXABLE: 'yes' })).toThrow();
  });
});
