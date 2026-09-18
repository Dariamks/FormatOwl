import { publishedTools } from '@/lib/published-tools';
import { conversionLandings } from '@/content/conversion-landings';
import { guides } from '@/content/guides';
import type { Locale } from '@/i18n/registry';
import { getSiteTranslations } from '@/i18n/server';
import { ArrowRight, ArrowUpRight, Download, SlidersHorizontal, Upload } from 'lucide-react';
import Link from 'next/link';
import { ExampleShowcase } from './example-preview';

const shortcuts = [
  {
    slug: 'heic-to-jpg',
    from: 'HEIC',
    to: 'JPG',
    description: 'shortcut_8cf3258c',
  },
  {
    slug: 'webp-to-jpg',
    from: 'WebP',
    to: 'JPG',
    description: 'shortcut_ee917691',
  },
  {
    slug: 'mov-to-mp4',
    from: 'MOV',
    to: 'MP4',
    description: 'shortcut_54c86e2c',
  },
  {
    slug: 'm4a-to-mp3',
    from: 'M4A',
    to: 'MP3',
    description: 'shortcut_38cb9b1d',
  },
];
export async function GuideCards({
  locale,
  slugs = Object.keys(guides),
}: {
  locale: Locale;
  slugs?: string[];
}) {
  const contentText = await getSiteTranslations('content');

  const copy = await getSiteTranslations('homeServer');

  return (
    <ul className="guide-card-grid">
      {slugs.map((slug) => {
        const guide = guides[slug];
        return (
          <li key={slug}>
            <Link href={`/${locale}/guide/${slug}`} className="guide-card">
              <span className="section-kicker">
                {slug.includes('video')
                  ? copy('video_size_quality_1363861')
                  : slug.includes('webp')
                    ? copy('images_format_transparency_614d4fd')
                    : copy('pdf_compression_content_192318e')}
              </span>
              <h3>{contentText(guide.title)}</h3>
              <p>{contentText(guide.description)}</p>
              <span className="card-read-more">
                {copy('read_guide_cf34ec5')}
                <ArrowRight size={16} />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
export async function HomeSections({ locale }: { locale: Locale }) {
  const { ids, visible, collectionVisible } = await publishedTools();
  const contentText = await getSiteTranslations('content');

  const copy = await getSiteTranslations('homeServer');

  const questions = [
    [
      copy('which_files_can_i_use_7516a73'),
      copy('formatowl_supports_video_audio_images_pdfs_09ce1c9'),
    ],
    [
      copy('do_i_need_to_pay_first_156c7e4'),
      copy('viewing_and_downloading_public_samples_is_b1657dd'),
    ],
    [
      copy('how_long_are_my_files_stored_8e65f0f'),
      copy('uploaded_originals_and_results_are_private_5d388a6'),
    ],
    [
      copy('will_every_file_get_the_same_result_2aec0ce'),
      copy('results_depend_on_the_content_original_enc_e2707aa'),
    ],
  ];
  return (
    <>
      <section className="home-section page-width">
        <ul className="guide-card-grid collection-card-grid">
          {(['convert', 'compress'] as const).filter(collectionVisible).map((collection) => (
            <li key={collection}>
              <Link className="guide-card" href={`/${locale}/${collection}`}>
                <h2>{copy(`${collection}Title`)}</h2>
                <p>{copy(`${collection}Description`)}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section
        className="home-section shortcuts-section page-width"
        aria-labelledby="shortcuts-title"
      >
        <div className="section-heading">
          <div>
            <span className="section-kicker">{copy('a_quick_change_of_format_999550c')}</span>
            <h2 id="shortcuts-title">{copy('convert_by_format_d714562')}</h2>
          </div>
        </div>
        <ul className="shortcut-grid">
          {shortcuts
            .filter((item) => visible(item.slug))
            .map((item) => (
              <li key={item.slug}>
                <Link
                  href={`/${locale}/tools/${item.slug}`}
                  aria-label={contentText(conversionLandings[item.slug].content.heading)}
                >
                  <div className="format-pair">
                    <span>{item.from}</span>
                    <ArrowRight size={16} />
                    <span>{item.to}</span>
                    <ArrowUpRight size={16} />
                  </div>
                  <p>{copy(item.description)}</p>
                </Link>
              </li>
            ))}
        </ul>
      </section>
      <ExampleShowcase locale={locale} publishedToolIds={ids} />
      <section className="steps page-width" aria-label={copy('three_simple_steps_dd19a1d')}>
        {[Upload, SlidersHorizontal, Download].map((Icon, i) => (
          <div key={i}>
            <span className="step-number">0{i + 1}</span>
            <Icon size={22} strokeWidth={1.6} />
            <h3>
              {
                [
                  copy('choose_your_file_52a52c3'),
                  copy('make_it_yours_5413515'),
                  copy('download_and_go_d5f118c'),
                ][i]
              }
            </h3>
            <p>
              {
                [
                  copy('choose_a_file_or_drop_files_of_the_same_ty_9cbe4e1'),
                  copy('start_with_a_preset_and_adjust_the_details_177b0f4'),
                  copy('preview_the_result_then_download_your_file_6961a8e'),
                ][i]
              }
            </p>
          </div>
        ))}
      </section>
      <section className="home-section guides-section page-width" aria-labelledby="guides-title">
        <div className="section-heading">
          <div>
            <span className="section-kicker">{copy('a_little_know_how_62bb994')}</span>
            <h2 id="guides-title">{copy('helpful_file_guides_535e62b')}</h2>
          </div>
          <Link className="section-link" href={`/${locale}/guide`}>
            {copy('all_guides_9b60654')}
            <ArrowRight size={16} />
          </Link>
        </div>
        <GuideCards locale={locale} />
      </section>
      <section className="home-section home-faq page-width" aria-labelledby="faq-title">
        <div>
          <span className="section-kicker">{copy('good_to_know_50f1880')}</span>
          <h2 id="faq-title">{copy('a_few_common_questions_bb50930')}</h2>
          <Link className="section-link" href={`/${locale}/pricing`}>
            {copy('view_credits_pricing_8d4b5e5')}
            <ArrowRight size={16} />
          </Link>
        </div>
        <div className="faq-list">
          {questions.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
