'use client';
import { authClient } from '@/lib/auth-client';
import type { AuthCapabilities } from '@/lib/auth-config';
import { authReturnPath } from '@/lib/auth-navigation';
import { request } from '@/lib/client-api';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from './ui/button';

type Mode = 'signin' | 'signup' | 'forgot' | 'reset';
export function Login({
  capabilities,
  onClose,
  next,
  initialMode = 'signin',
  token,
  verified = false,
  initialError = false,
}: {
  capabilities: AuthCapabilities;
  onClose?: () => void;
  next?: string;
  initialMode?: Mode;
  token?: string;
  verified?: boolean;
  initialError?: boolean;
}) {
  const t = useTranslations('login'),
    locale = useLocale(),
    id = useId();
  const { data: session, isPending } = authClient.useSession();
  const [mode, setMode] = useState<Mode>(initialMode),
    [email, setEmail] = useState('');
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    initialError ? t(initialMode === 'reset' ? 'invalidLink' : 'error') : '',
  );
  const [notice, setNotice] = useState(verified ? t('verified') : ''),
    [verifyPrompt, setVerifyPrompt] = useState(false);
  const [sent, setSent] = useState<'verify' | 'reset' | null>(null),
    [cooldown, setCooldown] = useState(0);
  const returnTo = authReturnPath(next, locale);
  const fetchOptions = { headers: { 'x-filemorph-locale': locale } };
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  function switchMode(value: Mode) {
    setMode(value);
    setError('');
    setNotice('');
    setSent(null);
    setVerifyPrompt(false);
    setPassword('');
    setConfirmation('');
    setShowPassword(false);
  }
  function failure(value: { code?: string; status?: number }) {
    if (value.code === 'EMAIL_NOT_VERIFIED') setVerifyPrompt(true);
    const key =
      value.status === 429
        ? 'rateLimited'
        : (
            {
              INVALID_EMAIL_OR_PASSWORD: 'invalidCredentials',
              EMAIL_NOT_VERIFIED: 'verifyFirst',
              PASSWORD_TOO_SHORT: 'passwordHint',
              PASSWORD_TOO_LONG: 'passwordHint',
              INVALID_TOKEN: 'invalidLink',
              TOKEN_EXPIRED: 'invalidLink',
              USER_ALREADY_EXISTS: 'existingAccount',
              USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'existingAccount',
            } as Record<string, string>
          )[value.code || ''] || 'error';
    setError(t(key));
  }
  async function finish() {
    await request('session');
    window.location.assign(returnTo);
  }
  function verificationCallback() {
    return `/${locale}/login?verified=1&next=${encodeURIComponent(returnTo)}`;
  }
  async function google() {
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: `/auth/complete?locale=${locale}&next=${encodeURIComponent(returnTo)}`,
        errorCallbackURL: `/${locale}/login?error=auth&next=${encodeURIComponent(returnTo)}`,
      });
      if (result.error) {
        failure(result.error);
        setBusy(false);
      }
    } catch {
      setError(t('error'));
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (
      (mode === 'signup' || mode === 'reset') &&
      (password.length < 12 || password.length > 128)
    ) {
      setError(t('passwordHint'));
      return;
    }
    if (mode === 'reset' && password !== confirmation) {
      setError(t('mismatch'));
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signin') {
        const result = await authClient.signIn.email({
          email: email.trim(),
          password,
          fetchOptions,
        });
        if (result.error) failure(result.error);
        else await finish();
      } else if (mode === 'signup') {
        const normalizedEmail = email.trim();
        const result = await authClient.signUp.email({
          email: normalizedEmail,
          name: normalizedEmail.split('@')[0],
          password,
          callbackURL: verificationCallback(),
          fetchOptions,
        });
        if (result.error) failure(result.error);
        else {
          setPassword('');
          setSent('verify');
          setCooldown(60);
        }
      } else if (mode === 'forgot') {
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: `/${locale}/reset-password`,
          fetchOptions,
        });
        if (result.error) failure(result.error);
        else {
          setSent('reset');
          setCooldown(60);
        }
      } else {
        const result = await authClient.resetPassword({
          newPassword: password,
          token,
          fetchOptions,
        });
        if (result.error) failure(result.error);
        else {
          switchMode('signin');
          setNotice(t('resetDone'));
          window.history.replaceState(null, '', `/${locale}/login`);
        }
      }
    } catch {
      setError(t('error'));
    } finally {
      setBusy(false);
    }
  }
  async function resend() {
    setBusy(true);
    setError('');
    try {
      const result = await authClient.sendVerificationEmail({
        email: email.trim(),
        callbackURL: verificationCallback(),
        fetchOptions,
      });
      if (result.error) failure(result.error);
      else {
        setSent('verify');
        setVerifyPrompt(false);
        setCooldown(60);
      }
    } catch {
      setError(t('error'));
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signOut();
      if (result.error) failure(result.error);
      else window.location.assign(`/${locale}`);
    } catch {
      setError(t('error'));
    } finally {
      setBusy(false);
    }
  }
  const signedIn = Boolean(session) && mode !== 'reset';
  const title = signedIn ? 'account' : sent ? 'checkEmail' : `${mode}Title`;
  return (
    <section className="auth-card" aria-label={t(title)}>
      {onClose && (
        <button type="button" className="auth-close" onClick={onClose} aria-label={t('close')}>
          <X size={22} />
        </button>
      )}
      <div className="auth-heading">
        <img src="/icon.png" className="brand-artwork" width={48} height={48} alt="FormatOwl" />
        <h1>{t(title)}</h1>
        <p>{t(signedIn ? 'accountSubtitle' : sent ? 'emailSubtitle' : `${mode}Subtitle`)}</p>
      </div>
      {error && (
        <div className="auth-alert auth-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="auth-alert auth-notice" role="status">
          <Check size={18} />
          {notice}
        </div>
      )}
      {signedIn ? (
        <div className="auth-account">
          <div className="auth-avatar" aria-hidden="true">
            {session?.user.name.slice(0, 1).toUpperCase()}
          </div>
          <strong>{session?.user.name}</strong>
          <span>{session?.user.email}</span>
          <Button
            onClick={() => {
              setBusy(true);
              void finish().catch(() => {
                setError(t('error'));
                setBusy(false);
              });
            }}
            disabled={busy}
          >
            {t('workspace')}
            <ArrowRight size={17} />
          </Button>
          <Button variant="outline" onClick={signOut} disabled={busy}>
            {t('signout')}
          </Button>
        </div>
      ) : sent ? (
        <div className="auth-sent">
          <div className="auth-mail-icon">
            <Mail size={28} />
          </div>
          <p role="status">{t(sent === 'verify' ? 'verificationSent' : 'resetSent', { email })}</p>
          <p className="auth-hint">{t('checkSpam')}</p>
          {sent === 'verify' && (
            <Button variant="outline" onClick={resend} disabled={busy || cooldown > 0}>
              {cooldown > 0 ? t('resendIn', { seconds: cooldown }) : t('resend')}
            </Button>
          )}
          <button
            className="auth-text-button"
            onClick={() => switchMode(sent === 'verify' ? 'signin' : 'forgot')}
            disabled={busy}
          >
            <ArrowLeft size={15} />
            {t(sent === 'verify' ? 'backSignin' : 'tryAnother')}
          </button>
        </div>
      ) : (
        <>
          {(mode === 'signin' || mode === 'signup') && (
            <>
              <Button
                variant="outline"
                className="auth-google"
                onClick={google}
                disabled={busy || !capabilities.google}
              >
                <svg width="19" height="19" viewBox="0 0 48 48" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.4 38.03 46.98 31.87 46.98 24.55Z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"
                  />
                </svg>
                {t('google')}
              </Button>
              {!capabilities.google && (
                <p className="auth-hint auth-centered">{t('googleUnavailable')}</p>
              )}
              <div className="form-divider">{t('or')}</div>
            </>
          )}
          {!capabilities.email && <div className="auth-alert">{t('emailUnavailable')}</div>}
          <form onSubmit={submit}>
            <fieldset disabled={busy || !capabilities.email || isPending}>
              {mode !== 'reset' && (
                <div className="auth-field-group">
                  <label htmlFor={`${id}-email`}>{t('email')}</label>
                  <div className="auth-input">
                    <Mail size={18} aria-hidden="true" />
                    <input
                      id={`${id}-email`}
                      type="email"
                      name="email"
                      autoComplete="email"
                      required
                      maxLength={254}
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setVerifyPrompt(false);
                      }}
                      placeholder="you@example.com"
                    />
                  </div>
                </div>
              )}
              {mode !== 'forgot' && (
                <div className="auth-field-group">
                  <label htmlFor={`${id}-password`}>
                    {t(mode === 'reset' ? 'newPassword' : 'password')}
                  </label>
                  <div className="auth-input">
                    <LockKeyhole size={18} aria-hidden="true" />
                    <input
                      id={`${id}-password`}
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                      required
                      minLength={mode === 'signin' ? undefined : 12}
                      maxLength={128}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      aria-describedby={mode !== 'signin' ? `${id}-hint` : undefined}
                    />
                    <button
                      type="button"
                      aria-label={t(showPassword ? 'hidePassword' : 'showPassword')}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  {mode !== 'signin' && (
                    <p className="auth-hint" id={`${id}-hint`}>
                      {t('passwordHint')}
                    </p>
                  )}
                </div>
              )}
              {mode === 'reset' && (
                <div className="auth-field-group">
                  <label htmlFor={`${id}-confirmation`}>{t('confirmPassword')}</label>
                  <div className="auth-input">
                    <LockKeyhole size={18} aria-hidden="true" />
                    <input
                      id={`${id}-confirmation`}
                      name="confirmation"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={128}
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                    />
                  </div>
                </div>
              )}
              <Button
                type="submit"
                className="auth-submit"
                disabled={mode === 'reset' && (!token || initialError)}
              >
                {busy ? t('working') : t(`${mode}Action`)}
                <ArrowRight size={17} />
              </Button>
            </fieldset>
          </form>
          {verifyPrompt && (
            <button className="auth-text-button" disabled={busy || cooldown > 0} onClick={resend}>
              {cooldown > 0 ? t('resendIn', { seconds: cooldown }) : t('resend')}
            </button>
          )}
          <div className="auth-links">
            {mode === 'signin' ? (
              <>
                <button onClick={() => switchMode('forgot')} disabled={busy}>
                  {t('forgotLink')}
                </button>
                <button onClick={() => switchMode('signup')} disabled={busy}>
                  {t('signupLink')}
                </button>
              </>
            ) : (
              <button
                onClick={() => switchMode(mode === 'reset' ? 'forgot' : 'signin')}
                disabled={busy}
              >
                <ArrowLeft size={15} />
                {t(mode === 'reset' ? 'requestNewLink' : 'backSignin')}
              </button>
            )}
          </div>
        </>
      )}
      {!signedIn && (
        <div className="auth-footer">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>{t('privacyNote')}</span>
        </div>
      )}
      {capabilities.localEmail && !signedIn && <p className="auth-local-note">{t('localEmail')}</p>}
      {!signedIn &&
        (onClose ? (
          <button className="auth-guest" onClick={onClose}>
            {t('guest')}
          </button>
        ) : (
          <Link className="auth-guest" href={`/${locale}/tools/video-compressor`}>
            {t('guest')}
          </Link>
        ))}
    </section>
  );
}
