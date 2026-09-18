'use client';
import { publicExamples, type PublicExample } from '@/content/examples';
import type { Locale } from '@/i18n/registry';
import { bytes } from '@/lib/utils';
import { ArrowRight, Download, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from './ui/button';

export function ExamplePreview({ example, locale }: { example: PublicExample; locale: Locale }) {
  const contentText = useTranslations('examples');

  const copy = useTranslations('homeExtra');

  const [failed, setFailed] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  return (
    <div className={`example-comparison example-${example.kind}`}>
      {(['input', 'output'] as const).map((side) => {
        const asset = example[side];
        const label = side === 'input' ? copy('original_c0a8060') : copy('result_5faa59d');
        return (
          <figure key={side}>
            <figcaption>
              <span>{label}</span>
              <strong>{bytes(asset.size)}</strong>
            </figcaption>
            <div
              className={`example-media ${example.kind === 'image' && side === 'input' ? 'example-transparency' : ''}`}
            >
              {failed.includes(side) ? (
                <div className="example-media-error" role="status">
                  <p>{copy('preview_could_not_load_47f0d34')}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setFailed((v) => v.filter((s) => s !== side));
                      setAttempt((v) => v + 1);
                    }}
                  >
                    <RotateCcw size={14} />
                    {copy('retry_9f5cd8a')}
                  </Button>
                </div>
              ) : example.kind === 'video' ? (
                <video
                  key={attempt}
                  controls
                  playsInline
                  preload="none"
                  poster={asset.preview}
                  src={asset.url}
                  aria-label={label}
                  onError={() => setFailed((v) => [...v, side])}
                />
              ) : (
                <img
                  key={attempt}
                  loading="lazy"
                  src={asset.preview ?? asset.url}
                  alt={`${contentText(example.title)} · ${label}`}
                  width={example.kind === 'pdf' ? 780 : 960}
                  height={example.kind === 'pdf' ? 1040 : 600}
                  onError={() => setFailed((v) => [...v, side])}
                />
              )}
            </div>
            <a className="example-file-link" href={asset.url} download={asset.name}>
              <Download size={14} />
              {copy('download_value0_e164995', { value0: label.toLowerCase() })}
            </a>
          </figure>
        );
      })}
    </div>
  );
}
export function ExampleShowcase({
  locale,
  publishedToolIds,
}: {
  locale: Locale;
  publishedToolIds: string[];
}) {
  const contentText = useTranslations('examples');

  const copy = useTranslations('homeExtra');

  const examples = publicExamples.filter((example) => publishedToolIds.includes(example.tool));
  const [selectedId, setSelectedId] = useState(examples[0]?.id);
  const selected = examples.find((example) => example.id === selectedId) || examples[0];
  if (!selected) return null;
  return (
    <section
      id="examples"
      className="home-section examples-section page-width"
      aria-labelledby="examples-title"
    >
      <div className="section-heading">
        <div>
          <span className="section-kicker">{copy('a_small_preview_0cf8e75')}</span>
          <h2 id="examples-title">{copy('see_what_a_little_change_can_do_8ac9725')}</h2>
          <p>{copy('explore_real_results_with_public_samples_n_f2eb04f')}</p>
        </div>
      </div>
      <div className="example-tabs" role="group" aria-label={copy('choose_an_example_8c8ac22')}>
        {examples.map((example) => (
          <button
            key={example.id}
            aria-pressed={selected.id === example.id}
            onClick={() => setSelectedId(example.id)}
          >
            {contentText(example.title)}
          </button>
        ))}
      </div>
      <div className="example-stage" key={selected.id}>
        <div className="example-intro">
          <h3>{contentText(selected.scenario)}</h3>
          <p>{contentText(selected.description)}</p>
        </div>
        <ExamplePreview example={selected} locale={locale} />
        <div className="example-footer">
          <div>
            <p>{contentText(selected.settings)}</p>
            <small>{copy('measured_for_this_sample_results_vary_by_f_8cde39b')}</small>
          </div>
          <Button asChild>
            <Link href={`/${locale}/tools/${selected.route}?sample=${selected.id}`}>
              {copy('try_this_sample_ad1e4f0')}
              <ArrowRight size={16} />
            </Link>
          </Button>
        </div>
        <p className="example-processing-note">
          {copy('viewing_and_downloading_samples_is_free_ne_36100d2')}
        </p>
      </div>
    </section>
  );
}
