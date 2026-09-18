'use client';
import type { Locale } from '@/i18n/registry';
import { pendingFiles } from '@/lib/pending-files';
import { tools } from '@filemorph/core/catalog';
import { fileTool, formats } from '@filemorph/core/domain';
import { ArrowUpRight, Check, Clock3, Plus, ShieldCheck, Upload, Video } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { ToolIcon } from './tool-icon';
import { Button } from './ui/button';
// A short-lived handoff: file bytes never go into browser storage.
export const pendingFile: { current: File | null } = { current: null };
export function Home({ publishedToolIds }: { publishedToolIds: readonly string[] }) {
  const labels = useTranslations('tools');

  const copy = useTranslations('homeExtra');

  const t = useTranslations('home'),
    locale = useLocale() as Locale,
    router = useRouter();
  const [group, setGroup] = useState('all'),
    [drag, setDrag] = useState(false),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  function select(files: File[]) {
    if (!files.length) return;
    const tool = fileTool(files[0].name);
    if (
      !tool ||
      !publishedToolIds.includes(tool) ||
      files.some((file) => fileTool(file.name) !== tool) ||
      ((tool === 'video-compressor' || tool.endsWith('-watermark-remover')) && files.length > 1) ||
      files.length > 20
    ) {
      setError(t('invalid'));
      return;
    }
    if (tool === 'video-compressor') pendingFile.current = files[0];
    else pendingFiles.current = files;
    router.push(`/${locale}/tools/${tool}`);
  }
  return (
    <>
      <section className="hero page-width">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="tiny-mark" />
            {t('eyebrow')}
          </div>
          <h1>
            {t('title')}
            <br />
            <span>{t('accent')}</span>
          </h1>
          <p className="hero-description">{t('description')}</p>
          <div className="format-chips">
            <span>
              <Video size={15} /> MP4
            </span>
            <span>
              <ToolIcon name="audio" size={15} /> MP3
            </span>
            <span>
              <ToolIcon name="image" size={15} /> JPG
            </span>
            <span>
              <ToolIcon name="file" size={15} /> PDF
            </span>
            <span className="and-more">{t('more')}</span>
          </div>
        </div>
        <div
          className={`upload-zone ${drag ? 'is-dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            select([...e.dataTransfer.files]);
          }}
        >
          <div className="upload-glyph">
            <Upload size={30} strokeWidth={1.6} />
            <span>
              <Plus size={12} />
            </span>
          </div>
          <h2>{t('drop')}</h2>
          <p>{t('or')}</p>
          <Button onClick={() => input.current?.click()}>
            <Plus size={18} />
            {t('choose')}
            <ArrowUpRight size={17} />
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            accept={Object.values(formats)
              .flat()
              .map((ext) => `.${ext}`)
              .join(',')}
            className="sr-only"
            aria-label={t('choose')}
            onChange={(e) => select([...(e.target.files || [])])}
          />
          <span className="upload-formats">{t('formats')}</span>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="upload-bottom">
            <a href="#examples" className="hero-example-link">
              {copy('no_file_handy_explore_a_sample_9f7e20a')} <ArrowUpRight size={14} />
            </a>
          </div>
        </div>
      </section>
      <div className="trust-strip page-width">
        <span>
          <ShieldCheck size={17} />
          {t('privacy')}
        </span>
        <span>
          <Clock3 size={17} />
          {t('expiry')}
        </span>
        <span>
          <Check size={17} />
          {t('signup')}
        </span>
      </div>
      <section id="tools" className="tools-section page-width">
        <div className="section-heading">
          <div>
            <div className="catalog-title">
              <h2>{t('toolTitle')}</h2>
              <span
                className="catalog-count"
                aria-label={t('toolCount', { count: publishedToolIds.length })}
              >
                {publishedToolIds.length}
              </span>
            </div>
            <p>{t('toolSub')}</p>
          </div>
        </div>
        <div className="filter-tabs" role="group" aria-label={t('all')}>
          {['all', 'video', 'audio', 'image', 'document', 'ai'].map((g) => (
            <button
              key={g}
              aria-pressed={group === g}
              className={group === g ? 'active' : ''}
              onClick={() => setGroup(g)}
            >
              {g === 'ai' && <ToolIcon name="languages" size={15} />} {t(g)}
            </button>
          ))}
        </div>
        <div className="tools-grid">
          {tools
            .filter((tool) => publishedToolIds.includes(tool.id))
            .filter((tool) => group === 'all' || tool.group === group)
            .map((tool) => (
              <Link
                className="tool-card"
                data-group={tool.group}
                key={tool.id}
                href={`/${locale}/tools/${tool.id}`}
              >
                <div className="tool-card-top">
                  <span className={`tool-icon ${tool.group}`}>
                    <ToolIcon name={tool.icon} />
                  </span>
                  {!tool.ready && <span className="soon-badge">{t('soon')}</span>}
                </div>
                <h3>
                  {labels(`${tool.id}.name`)}
                  <ArrowUpRight size={17} />
                </h3>
                <p>{labels(`${tool.id}.description`)}</p>
                <span className="tool-formats">{tool.formats}</span>
              </Link>
            ))}
        </div>
      </section>
    </>
  );
}
