'use client';
import { useErrorTranslator } from '@/i18n/errors';
import { useLanguageName } from '@/i18n/language-name';
import { errorMessage, request } from '@/lib/client-api';
import type { ReadingActivity, ReadingOptions, ReadingResult } from '@filemorph/core/reading';
import { readingMarkdown } from '@filemorph/core/reading-markdown';
import { translationLanguages, type TranslationData } from '@filemorph/core/translation';
import { Copy, Download, Languages, RefreshCw, Send, Sparkles, Square, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { CostEstimate } from './cost-estimate';
import { ReadingMap } from './reading-map';
import { Button } from './ui/button';
import { SelectField, SelectItem } from './ui/select';
type Tab = 'summary' | 'mindmap' | 'chat';
const running = (a: ReadingActivity) => ['queued', 'processing', 'cancelling'].includes(a.state);
const answer = (a?: ReadingActivity) => (a?.result && 'sections' in a.result ? a.result : null);

export function ReadingPanel({
  id,
  data,
  revision,
  open,
  ready,
  beforeGenerate,
  onLocate,
  onClose,
  autoGenerate = true,
  activeTab,
  onTabChange,
}: {
  id: string;
  data: TranslationData;
  revision: number;
  open: boolean;
  ready: boolean;
  beforeGenerate: () => Promise<number>;
  onLocate: (id: string) => void;
  onClose: () => void;
  autoGenerate?: boolean;
  activeTab?: Tab;
  onTabChange?: (tab: Tab) => void;
}) {
  const languageName = useLanguageName();

  const translateError = useErrorTranslator();

  const copy = useTranslations('reading');

  const locale = useLocale(),
    zh = locale === 'zh';
  const [localTab, setLocalTab] = useState<Tab>('summary');
  const tab = activeTab ?? localTab;
  const setTab = onTabChange ?? setLocalTab;
  const [language, setLanguage] = useState<ReadingOptions['language']>(zh ? 'zh' : 'en');
  const pdf = data.format === 'pdf';
  const [detail, setDetail] = useState<ReadingOptions['detail']>(pdf ? 'detailed' : 'brief');
  const [template, setTemplate] = useState<ReadingOptions['template']>('notes');
  const [activities, setActivities] = useState<ReadingActivity[]>([]);
  const [hash, setHash] = useState(''),
    [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState(''),
    [copied, setCopied] = useState('');
  const submitRef = useRef(beforeGenerate),
    requested = useRef(new Set<string>()),
    alive = useRef(true);
  const submitting = useRef(false),
    pending = useRef<{ key: string; requestId: string } | null>(null);
  submitRef.current = beforeGenerate;
  const loadSequence = useRef(0);
  async function load() {
    const sequence = ++loadSequence.current;
    const r = await request<{ contentHash: string; activities: ReadingActivity[] }>(
      `jobs/${id}/reading`,
    );
    if (alive.current && sequence === loadSequence.current) {
      setActivities(r.activities);
      setHash(r.contentHash);
      setLoaded(true);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load().catch((e) => setError(errorMessage(e, translateError)));
    const timer = setInterval(() => void load().catch(() => {}), 2000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [id, locale]);
  function selection(kind: Tab) {
    const matching = activities.filter(
      (a) =>
        a.kind === kind &&
        a.options.language === language &&
        (kind !== 'summary' ||
          (a.options.detail === detail && (a.options.template || 'notes') === template)),
    );
    const current = matching.find((a) => a.contentHash === hash) || matching[0];
    const published =
      matching.find((a) => a.contentHash === hash && a.state === 'completed' && answer(a)) ||
      matching.find((a) => a.state === 'completed' && answer(a));
    return { current, published };
  }
  const groups = new Map<string, ReadingActivity[]>();
  for (const a of activities.filter((a) => a.kind === 'chat')) {
    const turn = a.options.turnId || a.id;
    groups.set(turn, [...(groups.get(turn) || []), a]);
  }
  const chats = [...groups.values()].sort((a, b) =>
    a.at(-1)!.createdAt.localeCompare(b.at(-1)!.createdAt),
  );
  const lastChat = chats.at(-1);
  const { current, published } = selection(tab);
  const displayed =
    tab === 'chat' ? lastChat?.find((a) => a.state === 'completed' && answer(a)) : published;
  const generating = activities.some((a) => a.kind === tab && running(a));
  async function generate(text?: string, regenerate = false) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    const target = tab === 'chat' && regenerate ? lastChat?.[0] : undefined;
    const key = JSON.stringify([tab, language, detail, template, text, regenerate, target?.id]);
    if (pending.current?.key !== key) pending.current = { key, requestId: crypto.randomUUID() };
    try {
      const revision = await submitRef.current();
      const a = await request<ReadingActivity>(`jobs/${id}/reading`, {
        kind: tab,
        revision,
        language,
        detail,
        template,
        regenerate,
        question: tab === 'chat' ? target?.options.question || text || '' : '',
        requestId: pending.current.requestId,
        ...(target ? { regenerateOf: target.id } : {}),
      });
      setActivities((all) => [a, ...all.filter((v) => v.id !== a.id)]);
      pending.current = null;
      if (tab === 'chat' && !regenerate) setQuestion('');
      await load();
    } catch (e) {
      setError(errorMessage(e, translateError));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!autoGenerate || !open || !ready || !loaded || tab === 'chat' || current || busy) return;
    const key = `${tab}:${language}:${detail}:${template}`;
    if (requested.current.has(key)) return;
    requested.current.add(key);
    void generate();
  }, [autoGenerate, open, ready, loaded, tab, language, detail, template, current, busy]);
  async function action(a: ReadingActivity, operation: 'retry' | 'cancel') {
    try {
      await request(`reading-activities/${a.id}/${operation}`, {});
      await load();
    } catch (e) {
      setError(errorMessage(e, translateError));
    }
  }
  async function download(a: ReadingActivity, format: string) {
    try {
      const r = await request<{ url: string }>(
        `reading-activities/${a.id}/download?format=${format}`,
      );
      const link = document.createElement('a');
      link.href = r.url;
      link.download = `${a.kind}.${format}`;
      link.click();
    } catch (e) {
      setError(errorMessage(e, translateError));
    }
  }
  async function copyAnswer(a: ReadingActivity) {
    const r = answer(a);
    if (!r) return;
    try {
      await navigator.clipboard.writeText(readingMarkdown(r, data, a.options, a.citationTimes));
      setCopied(a.id);
    } catch {
      setError(copy('copy_failed_download_the_text_instead_beb0784'));
    }
  }
  const label = (id: string, times: Record<string, number> = {}) => {
    const time = times[id];
    if (time !== undefined)
      return `${Math.floor(time / 60000)}:${String(Math.floor(time / 1000) % 60).padStart(2, '0')}`;
    const b = data.blocks.find((b) => b.id === id);
    if (!b) return copy('source_6da13ad');
    if (b.startMs !== undefined)
      return `${Math.floor(b.startMs / 60000)}:${String(Math.floor(b.startMs / 1000) % 60).padStart(2, '0')}`;
    return ['docx', 'txt'].includes(data.format)
      ? `${copy('paragraph_05058e0')} ${data.blocks.indexOf(b) + 1}`
      : copy('pageNumber', { number: b.page + 1 });
  };
  function citations(
    cs: ReadingResult['sections'][number]['citations'],
    times?: Record<string, number>,
  ) {
    return (
      <div className="reading-citations">
        {cs.map((c, i) => (
          <button key={i} title={c.quote} onClick={() => onLocate(c.blockId)}>
            {label(c.blockId, times)} ↗
          </button>
        ))}
      </div>
    );
  }
  function result(a: ReadingActivity) {
    const r = answer(a);
    if (!r) return null;
    return (
      <article
        key={a.id}
        className={`reading-answer ${a.kind === 'mindmap' ? 'reading-map-answer' : ''}`}
        dir={a.options.language === 'ar' ? 'rtl' : 'ltr'}
      >
        {a.contentHash !== hash && (
          <p className="reading-stale">
            {copy('file_text_changed_this_analysis_uses_an_ea_ed79b7b')}
          </p>
        )}
        <h3>{r.title}</h3>
        {r.insufficient && (
          <p className="reading-evidence-note">
            {copy('this_file_does_not_provide_enough_informat_b6f93dd')}
          </p>
        )}
        {a.kind === 'mindmap' && r.nodes.length > 0 && (
          <ReadingMap result={r} onLocate={onLocate} onDownload={() => download(a, 'png')} />
        )}
        {(a.kind === 'mindmap' ? [] : r.sections).map((s, i) => (
          <section key={i}>
            <h4>{s.heading}</h4>
            {s.text && (
              <>
                <p>{s.text}</p>
                {citations(s.citations, a.citationTimes)}
              </>
            )}
            {s.blocks?.map((block, j) =>
              block.type === 'paragraph' ? (
                <div key={j}>
                  <p>{block.text}</p>
                  {citations(block.citations, a.citationTimes)}
                </div>
              ) : block.type === 'list' ? (
                <ul key={j}>
                  {block.items.map((item, k) => (
                    <li key={k}>
                      <span>{item.text}</span>
                      {citations(item.citations, a.citationTimes)}
                    </li>
                  ))}
                </ul>
              ) : (
                <div key={j} className="reading-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        {block.columns.map((col, k) => (
                          <th key={k} scope="col">
                            {col}
                          </th>
                        ))}
                        <th scope="col">{copy('sources_2eb56be')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {block.rows.map((row, k) => (
                        <tr key={k}>
                          {row.cells.map((cell, l) => (
                            <td key={l}>{cell}</td>
                          ))}
                          <td>{citations(row.citations, a.citationTimes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ),
            )}
          </section>
        ))}
      </article>
    );
  }
  function status(a?: ReadingActivity) {
    if (!a || a.state === 'completed') return null;
    return running(a) ? (
      <div className="reading-generating" role="status">
        <span className="spin">◌</span>
        <span>
          {a.state === 'cancelling'
            ? copy('stopping_827c972')
            : a.waitingUntil
              ? copy('waiting_for_service_capacity_bdcf676')
              : copy('reading_your_file_3a04bef')}
          {a.totalUnits > 1 ? ` ${a.completedUnits}/${a.totalUnits}` : ''}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={a.state === 'cancelling'}
          onClick={() => action(a, 'cancel')}
        >
          <Square size={12} />
          {copy('stop_9e25347')}
        </Button>
      </div>
    ) : ['failed', 'cancelled'].includes(a.state) ? (
      <div className="reading-generation-error" role="status">
        <span>
          {a.error ? errorMessage(a.error, translateError) : copy('generation_stopped_534d530')}
        </span>
        <Button size="sm" variant="outline" onClick={() => action(a, 'retry')}>
          <RefreshCw size={14} />
          {copy('retry_9f5cd8a')}
        </Button>
      </div>
    ) : null;
  }
  return (
    <aside
      className="reading-panel reader-column"
      hidden={!open}
      aria-label={copy('ai_reading_9f127e6')}
    >
      <header className="reader-column-toolbar">
        <div
          className="translation-segmented reading-tabs"
          role="tablist"
          aria-label={copy('ai_features_59f0c68')}
        >
          {(['summary', 'mindmap', 'chat'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              className={tab === k ? 'active' : ''}
              onClick={() => setTab(k)}
            >
              {k === 'summary'
                ? copy('summary_12b71c3')
                : k === 'mindmap'
                  ? copy('mind_map_fcb9bd3')
                  : copy('ask_ai_8dbaeb8')}
            </button>
          ))}
        </div>
        <div className="reading-header-actions">
          <details className="reading-menu">
            <summary
              aria-label={copy('ai_output_language_7d48d04')}
              title={copy('ai_output_language_7d48d04')}
            >
              <Languages size={17} />
            </summary>
            <div className="reading-menu-popover">
              <label>
                {copy('output_language_aedf056')}
                <SelectField
                  aria-label={copy('ai_output_language_options_c903bd8')}
                  value={language}
                  onValueChange={(nextValue) => setLanguage(nextValue as typeof language)}
                >
                  {translationLanguages.map((l) => (
                    <SelectItem key={l} value={l}>
                      {languageName(l)}
                    </SelectItem>
                  ))}
                </SelectField>
              </label>
            </div>
          </details>
          <Button
            size="sm"
            variant="ghost"
            disabled={!displayed}
            aria-label={copy('copy_analysis_390a9e2')}
            title={
              copied === displayed?.id ? copy('copied_8e3df45') : copy('copy_analysis_390a9e2')
            }
            onClick={() => displayed && copyAnswer(displayed)}
          >
            {copied === displayed?.id ? <span>✓</span> : <Copy size={16} />}
          </Button>
          <details className="reading-menu">
            <summary
              aria-label={copy('download_analysis_9da398b')}
              title={copy('download_analysis_9da398b')}
            >
              <Download size={17} />
            </summary>
            <div className="reading-menu-popover">
              {displayed ? (
                displayed.formats
                  .filter((f) => ['md', 'png', 'svg'].includes(f))
                  .map((f) => (
                    <button
                      key={f}
                      onClick={(e) => {
                        e.currentTarget.closest('details')?.removeAttribute('open');
                        void download(displayed, f);
                      }}
                    >
                      {f === 'md' ? copy('outline_markdown_b6fc986') : f.toUpperCase()}
                    </button>
                  ))
              ) : (
                <span>{copy('available_after_generation_6c9333c')}</span>
              )}
            </div>
          </details>
          <Button
            size="sm"
            disabled={!ready || busy || generating || (tab === 'chat' && !lastChat)}
            onClick={() => generate(undefined, true)}
            aria-label={copy('regenerate_b04c991')}
          >
            <RefreshCw size={15} />
            <span className="reading-regenerate-label">{copy('regenerate_b04c991')}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={copy('close_ai_reading_cbba5e8')}
            onClick={onClose}
          >
            <X size={17} />
          </Button>
        </div>
      </header>
      <div className={`reading-card ${tab === 'mindmap' ? 'is-map' : ''}`}>
        <div className="reading-options">
          {tab === 'summary' ? (
            <>
              <label>
                {copy('level_7c7f5d0')}
                <SelectField
                  aria-label={copy('summary_length_05f0f52')}
                  value={detail}
                  onValueChange={(nextValue) => setDetail(nextValue as typeof detail)}
                >
                  {pdf ? (
                    <>
                      <SelectItem value="detailed">{copy('detailed_c9d88a8')}</SelectItem>
                      <SelectItem value="brief">{copy('default_808d7dc')}</SelectItem>
                      <SelectItem value="comprehensive">{copy('comprehensive_0ba756d')}</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="brief">{copy('brief_230e0f8')}</SelectItem>
                      <SelectItem value="detailed">{copy('detailed_c9d88a8')}</SelectItem>
                    </>
                  )}
                </SelectField>
              </label>
              <label>
                {copy('template_3ec1ae0')}
                <SelectField
                  aria-label={copy('summary_template_dc7ac1c')}
                  value={template}
                  onValueChange={(nextValue) => setTemplate(nextValue as typeof template)}
                >
                  <SelectItem value="notes">{copy('ai_notes_6c90546')}</SelectItem>
                  {pdf ? (
                    <>
                      <SelectItem value="summary">{copy('summary_12b71c3')}</SelectItem>
                      <SelectItem value="meeting">{copy('meeting_minutes_c5af8bc')}</SelectItem>
                      <SelectItem value="analysis">{copy('analysis_62c7fcf')}</SelectItem>
                      <SelectItem value="review">{copy('review_e29a79f')}</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="takeaways">{copy('key_takeaways_efa0357')}</SelectItem>
                      <SelectItem value="chapters">{copy('chapter_summary_95c5839')}</SelectItem>
                    </>
                  )}
                </SelectField>
              </label>
            </>
          ) : (
            <span>
              {tab === 'mindmap'
                ? copy('select_a_node_for_sources_drag_to_pan_fffe1d5')
                : copy('answers_grounded_in_this_file_b7786e8')}
            </span>
          )}
          <span className="reading-output-language">{languageName(language)}</span>
        </div>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {!ready && (
          <p className="reading-not-ready">
            {copy('ai_reading_becomes_available_when_processi_c6f6241')}
          </p>
        )}
        {(['summary', 'mindmap'] as const).map((kind) => {
          const { current: latest, published: saved } = selection(kind);
          return (
            <div
              key={kind}
              className={`reading-tab-content ${kind === 'mindmap' ? 'is-map' : ''}`}
              hidden={tab !== kind}
            >
              {status(latest)}
              <div className="reading-panel-body">
                {saved ? (
                  result(saved)
                ) : !latest && ready && loaded ? (
                  <div className="reading-empty">
                    <Sparkles size={28} />
                    {data.format === 'transcript' && (
                      <p className="transcript-reading-intro">
                        {copy('turn_the_conversation_into_clear_notes_wit_6704571')}
                      </p>
                    )}
                    <Button disabled={busy} onClick={() => generate()}>
                      {busy ? copy('preparing_0b1d6c0') : copy('generate_analysis_a3ba45f')}
                    </Button>
                  </div>
                ) : null}
              </div>
              {latest && latest.contentHash !== hash && (
                <Button
                  className="reading-update"
                  variant="outline"
                  disabled={busy || generating || !ready}
                  onClick={() => generate()}
                >
                  <RefreshCw size={14} />
                  {copy('update_from_latest_text_4242d7c')}
                </Button>
              )}
            </div>
          );
        })}
        <div className="reading-tab-content" hidden={tab !== 'chat'}>
          <div className="reading-panel-body reading-chat-body">
            {chats.map((versions) => {
              const latest = versions[0],
                saved = versions.find((a) => a.state === 'completed' && answer(a));
              return (
                <div className="reading-chat-turn" key={latest.options.turnId || latest.id}>
                  <div className="reading-question">{latest.options.question}</div>
                  {status(latest)}
                  {saved && result(saved)}
                  {saved && (
                    <Button variant="ghost" size="sm" onClick={() => copyAnswer(saved)}>
                      <Copy size={14} />
                      {copied === saved.id ? copy('copied_8e3df45') : copy('copy_answer_0545871')}
                    </Button>
                  )}
                </div>
              );
            })}
            {!chats.length && (
              <div className="reading-empty">
                <Sparkles size={26} />
                <h3>{copy('ask_about_this_file_153c841')}</h3>
                <p>{copy('answers_include_references_back_to_the_fil_7142744')}</p>
                {[
                  copy('what_is_this_file_about_bbf1052'),
                  copy('which_details_deserve_attention_8d8eaf7'),
                  copy('what_information_is_missing_from_this_file_ad0fb8a'),
                ].map((q) => (
                  <button
                    key={q}
                    disabled={!ready || busy || generating}
                    onClick={() => generate(q)}
                  >
                    {q} ↗
                  </button>
                ))}
              </div>
            )}
          </div>
          <form
            className="reading-chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (question.trim()) void generate(question.trim());
            }}
          >
            <textarea
              aria-label={copy('ask_a_question_about_the_file_061b59e')}
              placeholder={copy('ask_about_this_file_635678d')}
              value={question}
              maxLength={2000}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <Button
              disabled={!question.trim() || !ready || busy || generating}
              type="submit"
              aria-label={copy('send_question_9e3cdd6')}
            >
              <Send size={16} />
            </Button>
          </form>
        </div>
        {open && (
          <CostEstimate
            tool="reading"
            operation={
              ready
                ? {
                    path: `jobs/${id}/reading`,
                    body: {
                      kind: tab,
                      revision,
                      language,
                      detail,
                      template,
                      question: tab === 'chat' ? question : '',
                    },
                  }
                : null
            }
            note={copy('estimated_for_this_text_volume_including_l_e7e0f92')}
          />
        )}
        <footer>{copy('based_on_extracted_text_check_the_linked_s_7219698')}</footer>
      </div>
    </aside>
  );
}
