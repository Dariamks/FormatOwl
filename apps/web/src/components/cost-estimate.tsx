'use client';
import { useTranslations } from 'next-intl';

import { request } from '@/lib/client-api';
import { referenceQuote, referenceWork } from '@filemorph/core/billing-estimate';
import type { BillingFacts, QuoteView } from '@filemorph/core/billing-model';
import { CircleHelp, Coins, RefreshCw } from 'lucide-react';
import { useLocale } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';

type Operation = { path: string; body: Record<string, unknown> };
const emptyFiles: File[] = [];
const metadataCache = new WeakMap<File, Promise<BillingFacts>>();

// Read browser metadata only. Unsupported codecs and document structures are probed by the worker.
async function fileFacts(file: File): Promise<BillingFacts> {
  const base: BillingFacts = { bytes: file.size, source: 'browser' };
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (!/^(mp4|mov|mkv|webm|mp3|wav|aac|m4a|flac|ogg|jpg|jpeg|png|webp|avif)$/.test(ext))
    return base;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const img = /^(jpg|jpeg|png|webp|avif)$/.test(ext);
      const node = img ? new Image() : document.createElement('video');
      const done = (facts = base) => {
        clearTimeout(timer);
        node.onload = node.onerror = null;
        if (node instanceof HTMLVideoElement) {
          node.onloadedmetadata = null;
          node.removeAttribute('src');
          node.load();
        }
        resolve(facts);
      };
      const timer = setTimeout(() => done(), 8000);
      node.onerror = () => done();
      if (node instanceof HTMLImageElement) {
        node.onload = () => done({ ...base, width: node.naturalWidth, height: node.naturalHeight });
      } else {
        node.preload = 'metadata';
        node.onloadedmetadata = () =>
          done({
            ...base,
            duration: Number.isFinite(node.duration) ? node.duration : undefined,
            width: node.videoWidth || undefined,
            height: node.videoHeight || undefined,
          });
      }
      node.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function CostEstimate({
  tool,
  files = emptyFiles,
  options = {},
  operation,
  note,
}: {
  tool: string;
  files?: File[];
  options?: unknown;
  operation?: Operation | null;
  note?: string;
}) {
  const copy = useTranslations('billing');

  const locale = useLocale();
  const [metadata, setMetadata] = useState<{ files: File[]; facts: BillingFacts[] } | null>(null);
  const [account, setAccount] = useState<{ mode: string; balance: { available: number } } | null>(
    null,
  );
  const [result, setResult] = useState<{ key: string; quote: QuoteView } | null>(null);
  const [error, setError] = useState(false),
    [reload, setReload] = useState(0);
  // File identity matters: two different files may have the same name and size.
  const sameFiles =
    metadata?.files.length === files.length && metadata.files.every((f, i) => f === files[i]);
  const key = operation ? JSON.stringify(operation) : '';
  const quote =
    result?.key === key && new Date(result.quote.expiresAt).getTime() > Date.now()
      ? result.quote
      : null;
  useEffect(() => {
    if (sameFiles) return;
    let active = true;
    void Promise.all(
      files.map((file) => {
        let pending = metadataCache.get(file);
        if (!pending) {
          pending = fileFacts(file);
          metadataCache.set(file, pending);
        }
        return pending;
      }),
    ).then((facts) => {
      if (active) setMetadata({ files, facts });
    });
    return () => {
      active = false;
    };
  }, [files, sameFiles]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void request<typeof account>('billing')
        .then((value) => {
          if (active) setAccount(value);
        })
        .catch(() => {
          if (active) setAccount(null);
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('filemorph-balance', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('filemorph-balance', refresh);
    };
  }, [reload]);
  useEffect(() => {
    setError(false);
    setResult(null);
    if (!key) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        let q = await request<QuoteView>('quote', { operation: JSON.parse(key) });
        const end = Date.now() + 65000;
        while (active && q.state === 'probing' && Date.now() < end) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (!active) return;
          q = await request<QuoteView>(`quotes/${q.id}`);
        }
        if (!active) return;
        if (q.state === 'failed' || q.state === 'probing') {
          setError(true);
          return;
        }
        setAccount({ mode: q.mode, balance: { available: q.balance } });
        setResult({ key, quote: q });
        timer = setTimeout(
          () => {
            setResult(null);
            void load();
          },
          Math.max(1000, Date.parse(q.expiresAt) - Date.now()),
        );
      } catch {
        if (active) setError(true);
      }
    };
    timer = setTimeout(() => void load(), 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, reload]);
  const reference = quote
    ? referenceQuote(quote.lines)
    : sameFiles
      ? referenceWork(tool, metadata.facts, options)
      : null;
  const exact = quote?.state === 'ready' && quote.estimatedCredits !== null;
  const amount = exact ? quote.estimatedCredits : reference?.credits;
  const mode = quote?.mode || account?.mode;
  const available = account?.balance.available ?? quote?.balance;
  const insufficient =
    mode === 'enforced' &&
    quote?.maximumCredits != null &&
    available != null &&
    available < quote.maximumCredits;
  const pending = !!key && !quote && !error;
  const status = error
    ? copy('estimate_unavailable_8e59513')
    : pending
      ? copy('estimating_e8642ee')
      : amount != null
        ? `${exact ? '' : '≈ '}${amount.toLocaleString(locale)}${!exact && reference?.incomplete ? '+' : ''} ${copy('credits_66c22fa')}`
        : files.length
          ? copy('after_file_analysis_7396f31')
          : copy('choose_a_file_to_estimate_c508eb0');
  const stages: Record<string, string> = {
    asr: 'speech_recognition_only_translation_repair_ecf00ad',
    ocr: 'text_recognition_only_translation_and_repa_0d33b28',
  };
  return (
    <div className={`cost-estimate ${insufficient ? 'cost-insufficient' : ''}`} data-tool={tool}>
      <div className="cost-estimate-line" role="status" aria-live="polite">
        <Coins size={16} aria-hidden="true" />
        <span>
          {copy('estimated_cost_516cbee')}: <strong>{status}</strong>
        </span>
        <span className="cost-balance">
          {copy('remaining_cc632b5')}{' '}
          <b>{available == null ? '—' : available.toLocaleString(locale)}</b>
        </span>
      </div>
      <div className="cost-estimate-meta">
        <span>
          {mode === 'shadow'
            ? copy('estimation_mode_no_charge_5a74aed')
            : exact
              ? `${copy('maximum_a8df2fe')} ${quote.maximumCredits} ${copy('credits_66c22fa')}`
              : copy('indicative_estimate_full_price_unverified_f37c088')}
        </span>
        {error && (
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw size={13} />
            {copy('retry_9f5cd8a')}
          </button>
        )}
        <details>
          <summary aria-label={copy('about_this_estimate_7860bd9')}>
            <CircleHelp size={14} />
          </summary>
          <div className="cost-explanation">
            <p>{copy('based_on_size_duration_pixels_pages_and_se_9337470')}</p>
            <p>{copy('resource_budgets_are_not_verified_prices_c_1afc5a9')}</p>
            <Link href={`/${locale}/pricing`}>
              {copy('view_credits_and_billing_rules_bf0223b')}
            </Link>
          </div>
        </details>
      </div>
      {(note || (quote && stages[quote.stage])) && (
        <p className="cost-stage">{note || copy(stages[quote!.stage])}</p>
      )}
      {insufficient && (
        <p className="cost-stage" role="alert">
          {copy('insufficient_credits_for_this_maximum_e835d2a')}{' '}
          <Link href={`/${locale}/pricing`}>{copy('view_credit_packs_a154c60')}</Link>
        </p>
      )}
    </div>
  );
}
