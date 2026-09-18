import { seoConfig } from './src/lib/seo-config';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
seoConfig();
const config: NextConfig = {
  transpilePackages: ['@filemorph/core'],
  serverExternalPackages: ['postgres', 'bullmq', 'ioredis'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
export default createNextIntlPlugin()(config);
