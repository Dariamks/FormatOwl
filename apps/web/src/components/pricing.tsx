'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { errorMessage, request } from '@/lib/client-api';
import { billingDefaults } from '@filemorph/core/billing-model';
import { tools } from '@filemorph/core/catalog';
import { Check } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Pagination } from '@filemorph/core/pagination';
import { ListPagination } from './list-pagination';
import { Button } from './ui/button';
type Overview = {
  pagination: Pagination;
  mode: string;
  salesEnabled: boolean;
  priceVersion: string;
  balance: { available: number; reserved: number };
  packs: { cny: number; credits: number; displayUsd: number }[];
  operations: {
    id: string;
    state: string;
    mode: string;
    reservedCredits: number;
    chargedCredits: number;
    createdAt: string;
  }[];
  ledger: { id: string; kind: string; amount: number; createdAt: string }[];
  payments: {
    configured: boolean;
    enabled: boolean;
    environment: 'test' | 'prod';
    availablePacks: string[];
  };
};
const packIds = ['basic', 'pro', 'premium'] as const;
const rules: Record<string, string> = {
  'video-compressor': 'duration_resolution_frame_rate_and_encodin_eac7f44',
  'video-converter': 'duration_resolution_and_output_codec_c941c7e',
  'video-cutter': 'preparation_and_exported_duration_c163916',
  'video-cropper': 'preparation_output_pixels_and_duration_c2f3df0',
  'audio-compressor': 'duration_channels_and_codec_d4872a1',
  'audio-converter': 'duration_channels_and_codec_d4872a1',
  'audio-cutter': 'source_preparation_and_exported_segments_dd9abe9',
  'video-to-mp3': 'track_preparation_and_selected_duration_671f6e1',
  'image-compressor': 'pixels_animation_frames_and_encoding_18fd397',
  'image-converter': 'pixels_frames_and_output_format_23008af',
  'pdf-compressor': 'pages_embedded_images_and_compression_mode_80b77b7',
  transcription: 'recognized_seconds_and_audio_preparation_ed6a5fe',
  'video-translator': 'recognition_translation_video_export_quote_181ff13',
  'document-translator': 'text_volume_scanned_pages_add_ocr_and_repa_263a093',
  'image-translator': 'ocr_translation_and_background_repair_regi_1486517',
  'image-watermark-remover': 'local_processing_or_cloud_repair_regions_b6e457e',
  'pdf-watermark-remover': 'pages_objects_ocr_and_repair_334b0ab',
  'word-watermark-remover': 'objects_preview_and_export_dcefd15',
  'ppt-watermark-remover': 'slides_objects_preview_and_export_1b5bfec',
};
export function Pricing({ publishedToolIds }: { publishedToolIds: string[] }) {
  const labels = useTranslations('tools');
  const translateError = useErrorTranslator();

  const copy = useTranslations('billing');

  const locale = useLocale(),
    [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState<any>(null),
    [changingPage, setChangingPage] = useState(false),
    [checkoutPack, setCheckoutPack] = useState<string | null>(null);
  const usageRef = useRef<HTMLElement>(null);
  const requestId = useRef(0);
  async function loadPage(page: number, scroll = false) {
    const id = ++requestId.current;
    setChangingPage(true);
    try {
      const result = await request<Overview>(`billing?page=${page}`);
      if (id !== requestId.current) return;
      setData(result);
      setError('');
      if (scroll) {
        setReceipt(null);
        usageRef.current?.scrollIntoView({ block: 'start' });
      }
    } catch (e) {
      if (id === requestId.current) setError(errorMessage(e, translateError));
    } finally {
      if (id === requestId.current) setChangingPage(false);
    }
  }
  useEffect(() => {
    void loadPage(1);
    return () => {
      requestId.current++;
    };
  }, [locale]);
  async function startCheckout(packId: (typeof packIds)[number]) {
    setCheckoutPack(packId);
    try {
      const result = await request<{ checkoutUrl: string }>('billing/checkout', { pack: packId });
      window.open(result.checkoutUrl, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      setCheckoutPack(null);
    }
  }
  return (
    <div className="pricing-page">
      <div className="pricing-heading">
        <span className="pricing-eyebrow">{copy('creditHeading')}</span>
        <h1>{copy('pay_for_the_work_your_files_need_6afe135')}</h1>
        <p>{copy('choose_the_credits_you_need_confirm_a_maxi_88cbecb')}</p>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="credit-packs">
        {[
          { cny: 0, credits: 0, displayUsd: 0 },
          ...(data?.packs ??
            billingDefaults.packs.map((cny, i) => ({
              cny,
              credits: billingDefaults.packCredits[i],
              displayUsd: billingDefaults.packDisplayUsd[i],
            }))),
        ].map((pack, i) => (
          <section className={`credit-pack ${i === 2 ? 'featured' : ''}`} key={pack.cny}>
            {i === 2 && <span className="pack-badge">{copy('recommended_9ef9375')}</span>}
            <div className="pack-heading">
              <h2>
                {
                  [
                    copy('free_75f5271'),
                    copy('basic_aa2c96d'),
                    copy('pro_66d0c5e'),
                    copy('premium_6c2f288'),
                  ][i]
                }
              </h2>
              <p>
                {
                  [
                    copy('explore_before_you_choose_62d88e8'),
                    copy('for_occasional_file_tasks_12cfda9'),
                    copy('for_everyday_work_and_creation_c804beb'),
                    copy('for_frequent_use_and_batch_tasks_119d5af'),
                  ][i]
                }
              </p>
            </div>
            {i === 0 ? (
              <Button className="pack-action" variant="outline" asChild>
                <Link href={`/${locale}#examples`}>{copy('get_started_90e40d5')}</Link>
              </Button>
            ) : (
              (() => {
                const packId = packIds[i - 1];
                const purchasable = Boolean(
                  data?.payments.enabled && data.payments.availablePacks.includes(packId),
                );
                return (
                  <Button
                    className="pack-action"
                    disabled={!purchasable || checkoutPack === packId}
                    onClick={() => void startCheckout(packId)}
                  >
                    {checkoutPack === packId
                      ? '…'
                      : purchasable
                        ? locale.startsWith('zh')
                          ? '购买'
                          : 'Buy'
                        : copy('purchases_not_open_89000ed')}
                  </Button>
                );
              })()
            )}
            <div className="pack-pricing">
              <div className="pack-price-line">
                <strong className="pack-price">${pack.displayUsd}</strong>
                <span>{i === 0 ? 'USD' : copy('usd_one_time_7a52e65')}</span>
              </div>
              <p>
                {i === 0
                  ? copy('explore_tool_examples_no_subscription_0fa77be')
                  : copy('pay_as_you_go_no_auto_renewal_dfe9483')}
              </p>
            </div>
            <ul className="pack-features">
              {(i === 0
                ? [
                    copy('explore_tools_and_examples_for_free_b9d32bc'),
                    copy('discover_all_19_tools_80024f4', { count: publishedToolIds.length }),
                    copy('video_audio_image_and_pdf_tools_1444925'),
                    copy('preview_example_results_ee73331'),
                    copy('explore_transcription_translation_and_ai_r_692a187'),
                    copy('choose_a_credit_pack_when_needed_405e21a'),
                    copy('no_automatic_subscription_or_charges_56fb0fe'),
                    copy('paid_processing_credits_not_included_96f6c0f'),
                  ]
                : [
                    `${pack.credits.toLocaleString(locale)} ${copy('credits_66c22fa')}`,
                    copy('credits_work_across_all_19_tools_49960a7', {
                      count: publishedToolIds.length,
                    }),
                    copy('video_audio_image_and_pdf_tools_1444925'),
                    copy('transcription_translation_and_ai_reading_e2379fb'),
                    copy('confirm_your_budget_before_processing_ad21ef2'),
                    copy('unused_reserved_credits_returned_96d6a73'),
                    copy('no_extra_charge_to_re_download_before_expi_e7714ef'),
                    copy('files_automatically_removed_after_24_hours_a4a4bef'),
                  ]
              ).map((feature) => (
                <li key={feature}>
                  <Check size={20} strokeWidth={2} aria-hidden="true" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="pricing-status" role="status">
        {copy('cost_estimation_is_in_progress_credit_purc_6394f2a')}
      </p>
      <div className="billing-balance">
        <span>
          {copy('available_credits_18001da')}{' '}
          <strong>{data?.balance.available.toLocaleString(locale) ?? '—'}</strong>
        </span>
        <span>
          {copy('reserved_credits_41445b4')}{' '}
          <strong>{data?.balance.reserved.toLocaleString(locale) ?? '—'}</strong>
        </span>
      </div>
      <section className="pricing-rules">
        <h2>{copy('how_usage_is_calculated_8fa52b8')}</h2>
        <p>{copy('file_size_affects_transfer_and_storage_dur_2b442f7')}</p>
        <div className="billing-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{copy('tool_9a830c7')}</th>
                <th>{copy('usage_basis_ed3fc4f')}</th>
              </tr>
            </thead>
            <tbody>
              {tools
                .filter((tool) => publishedToolIds.includes(tool.id))
                .map((tool) => (
                  <tr key={tool.id}>
                    <td>{labels(`${tool.id}.name`)}</td>
                    <td>{copy(rules[tool.id])}</td>
                  </tr>
                ))}
              <tr>
                <td>{copy('summary_mind_map_chat_a7805a8')}</td>
                <td>{copy('input_and_output_tokens_including_document_253f922')}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section className="pricing-rules">
        <h2>{copy('billing_rules_a3b5f2e')}</h2>
        <ul>
          <li>{copy('recognition_translation_and_repair_may_be_9ccfc68')}</li>
          <li>{copy('reusing_an_existing_result_has_no_processi_a72c14d')}</li>
          <li>{copy('cancellation_settles_performed_work_failur_e4ca200')}</li>
          <li>{copy('files_retain_the_24_hour_expiry_credit_pac_4f3d13c')}</li>
        </ul>
      </section>
      <section className="pricing-rules billing-history" ref={usageRef} aria-busy={changingPage}>
        <h2>{copy('usage_and_receipts_270ecc2')}</h2>
        {!data?.operations.length ? (
          <p>{copy('no_billing_records_yet_your_itemized_usage_99a4623')}</p>
        ) : (
          <div className="billing-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{copy('date_eb9a4bc')}</th>
                  <th>{copy('status_bae7d5b')}</th>
                  <th>{copy('charged_deb41ca')}</th>
                  <th>{copy('details_dc3decb')}</th>
                </tr>
              </thead>
              <tbody>
                {data.operations.map((op) => (
                  <tr key={op.id}>
                    <td>{new Date(op.createdAt).toLocaleString(locale)}</td>
                    <td>
                      {copy.has(`state_${op.state}`) ? copy(`state_${op.state}`) : op.state}
                      {op.mode === 'shadow' ? ` · ${copy('estimate_2352230')}` : ''}
                    </td>
                    <td>{op.chargedCredits.toLocaleString(locale)}</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() =>
                          void request(`billing/receipts/${op.id}`)
                            .then(setReceipt)
                            .catch((e) => setError(errorMessage(e, translateError)))
                        }
                      >
                        {copy('view_receipt_3da41a8')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <ListPagination
            pagination={data.pagination}
            label={copy('usage_and_receipts_270ecc2')}
            disabled={changingPage}
            onChange={(page) => void loadPage(page, true)}
          />
        )}
        {receipt && (
          <div className="billing-receipt">
            <h3>{copy('itemized_usage_7f7e970')}</h3>
            <p>
              {copy('price_version_8b860da')}: {receipt.priceVersion} · {copy('charged_deb41ca')}{' '}
              {receipt.chargedCredits}
            </p>
            <ul>
              {receipt.lines.map((line: any, i: number) => (
                <li key={i}>
                  {line.stage} · {line.meter}: {Math.round(line.quantity * 100) / 100} ·{' '}
                  {line.credits === null
                    ? copy('unpriced_9e35193')
                    : `${line.credits.toLocaleString(locale)} ${copy('credits_66c22fa')}`}{' '}
                  · {line.state}
                  {line.platformLoss ? ` · ${copy('platform_cost_not_charged_2817a0c')}` : ''}
                </li>
              ))}
            </ul>
            <small>{copy('line_credits_are_indicative_final_rounding_323fddf')}</small>
          </div>
        )}
      </section>
    </div>
  );
}
