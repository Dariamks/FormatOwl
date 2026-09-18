'use client';
import {
  setBillingConfirmation,
  type BillingConfirmation as Confirmation,
} from '@/lib/billing-client';
import type { QuoteView } from '@filemorph/core/billing-model';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { WorkspaceDialog } from './workspace-dialog';
export function QuoteSummary({ quote }: { quote: QuoteView }) {
  const copy = useTranslations('common');

  const locale = useLocale();
  return (
    <div className="billing-quote" role="status">
      <strong>
        {quote.estimatedCredits === null
          ? copy('full_price_pending_verification_deb6532')
          : `${copy('estimated_ae64c7c')} ${quote.estimatedCredits.toLocaleString(locale)} ${copy('credits_66c22fa')}`}
      </strong>
      <span>
        {quote.maximumCredits === null
          ? quote.knownCredits
            ? `${copy('indicative_portion_fde2deb')} ${quote.knownCredits.toLocaleString(locale)} ${copy('credits_66c22fa')}`
            : ''
          : `${copy('maximum_a8df2fe')} ${quote.maximumCredits.toLocaleString(locale)} ${copy('credits_66c22fa')}`}{' '}
        · {copy('available_7c62a14')} {quote.balance.toLocaleString(locale)}
      </span>
      {quote.mode === 'shadow' && (
        <small>{copy('cost_estimation_mode_no_credits_are_charge_c184372')}</small>
      )}
    </div>
  );
}
function quoteLabel(label: string) {
  const name = label.split(' / ')[0];
  const labels: Record<string, string> = {
    Processing: 'quoteLine0',
    '24h storage': 'quoteLine1',
    Transfer: 'quoteLine2',
    'Object reads': 'quoteLine3',
    'Object writes': 'quoteLine4',
    'Source preparation': 'quoteLine5',
    'Speech recognition': 'quoteLine6',
    'Background repair regions': 'quoteLine7',
    'Selected repair regions': 'quoteLine8',
  };
  return (
    labels[name] ??
    (name.endsWith(' input')
      ? 'quoteInput'
      : name.endsWith(' output')
        ? 'quoteOutput'
        : 'quoteLine0')
  );
}
export function BillingConfirmation() {
  const copy = useTranslations('common');

  const locale = useLocale(),
    [queue, setQueue] = useState<Confirmation[]>([]),
    pending = useRef<Confirmation[]>([]);
  useEffect(() => {
    setBillingConfirmation((r) => {
      pending.current.push(r);
      setQueue([...pending.current]);
    });
    return () => {
      setBillingConfirmation(undefined);
      pending.current.forEach((r) => r.resolve(false));
      pending.current = [];
    };
  }, []);
  const current = queue[0];
  function finish(yes: boolean) {
    current?.resolve(yes);
    pending.current.shift();
    setQueue([...pending.current]);
  }
  if (!current) return null;
  const q = current.quote,
    ready = q.state === 'ready' && q.maximumCredits !== null && q.balance >= q.maximumCredits;
  return (
    <WorkspaceDialog
      open
      onClose={() => finish(false)}
      label={copy('confirm_credit_usage_378ab0b')}
      className="billing-dialog"
    >
      <h2>{copy('confirm_this_operation_7e1ddc9')}</h2>
      <QuoteSummary quote={q} />
      <p>{copy('the_maximum_is_reserved_unused_credits_are_041ea07')}</p>
      {['asr', 'ocr'].includes(q.stage) && (
        <p>{copy('this_confirms_recognition_only_translation_545f6a5')}</p>
      )}
      <details>
        <summary>{copy('cost_breakdown_e233f3f')}</summary>
        <ul>
          {q.lines.map((line, i) => (
            <li key={i}>
              {copy(quoteLabel(line.label))} ·{' '}
              {line.quantity.toLocaleString(locale, { maximumFractionDigits: 2 })} {line.meter}
              {!line.verified ? ` · ${copy('unverified_eb27a19')}` : ''}
            </li>
          ))}
        </ul>
      </details>
      {q.state !== 'ready' && (
        <p role="alert">{copy('pricing_is_not_verified_paid_processing_is_cfb2bdb')}</p>
      )}
      {q.maximumCredits !== null && q.balance < q.maximumCredits && (
        <p role="alert">{copy('insufficient_available_credits_e793233')}</p>
      )}
      <div className="billing-actions">
        <Button variant="outline" onClick={() => finish(false)}>
          {copy('cancel_77dfd21')}
        </Button>
        <Button disabled={!ready} onClick={() => finish(true)}>
          {copy('confirm_and_start_ae86c0b')}
        </Button>
      </div>
    </WorkspaceDialog>
  );
}
