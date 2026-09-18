export function authBaseURL() {
  return new URL(process.env.BETTER_AUTH_URL || process.env.APP_URL || 'http://127.0.0.1:3000')
    .origin;
}
export function localAuthEmail() {
  return (
    process.env.AUTH_EMAIL_MODE === 'local' &&
    process.env.NODE_ENV !== 'production' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(authBaseURL()).hostname)
  );
}
export function authCapabilities() {
  return {
    email: localAuthEmail() || Boolean(process.env.RESEND_API_KEY && process.env.AUTH_EMAIL_FROM),
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    localEmail: localAuthEmail(),
  };
}
export type AuthCapabilities = ReturnType<typeof authCapabilities>;
