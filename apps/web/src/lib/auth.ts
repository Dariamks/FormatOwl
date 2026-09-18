import { betterAuth } from 'better-auth';
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '@filemorph/core/db';
import * as schema from './auth-schema';
import { authBaseURL, authCapabilities } from './auth-config';
import { sendAuthEmail } from './auth-email';

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 random characters');
  const capabilities = authCapabilities();
  return betterAuth({
    appName: 'FormatOwl',
    baseURL: authBaseURL(),
    secret,
    database: drizzleAdapter(db(), { provider: 'pg', schema, transaction: true }),
    trustedOrigins:
      process.env.NODE_ENV === 'production'
        ? [authBaseURL()]
        : [authBaseURL(), 'http://127.0.0.1:3000', 'http://localhost:3000'],
    emailAndPassword: {
      enabled: capabilities.email,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 1800,
      sendResetPassword: async ({ user, url }, request) =>
        sendAuthEmail('reset', user.email, url, request),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }, request) =>
        sendAuthEmail('verify', user.email, url, request),
    },
    socialProviders: capabilities.google
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            requireEmailVerification: true,
            prompt: 'select_account',
          },
        }
      : {},
    account: {
      accountLinking: { enabled: true, trustedProviders: ['google'] },
      encryptOAuthTokens: true,
    },
    session: { expiresIn: 30 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    advanced: {
      cookiePrefix: 'filemorph',
      database: { generateId: () => randomUUID() },
      backgroundTasks: {
        handler: (promise) =>
          after(async () => {
            try {
              await promise;
            } catch {
              console.error('Authentication email delivery failed');
            }
          }),
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 3 },
        '/send-verification-email': { window: 60, max: 3 },
        '/reset-password': { window: 60, max: 5 },
      },
    },
  });
}
let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return (auth ||= createAuth());
}
