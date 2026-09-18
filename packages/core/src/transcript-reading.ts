import type { TranscriptData, TranscriptSpeaker } from './transcription';
import type { TranslationData } from './translation';

export function transcriptSpeakerName(speaker: TranscriptSpeaker, index: number, language = 'en') {
  return /^\d+ · /u.test(speaker.name)
    ? `${language === 'zh' ? '说话人' : 'Speaker '}${index + 1}`
    : speaker.name;
}

// Reuse the reading pipeline without creating a second, independently editable document.
export function transcriptReadingData(data: TranscriptData, language = 'auto'): TranslationData {
  const speakers = new Map(data.speakers.map((s, i) => [s.id, transcriptSpeakerName(s, i)]));
  return {
    format: 'transcript',
    sourceLanguage: language,
    targetLanguage: language,
    durationMs: data.durationMs,
    pages: [],
    blocks: data.segments.map((s) => ({
      id: s.id,
      page: 0,
      kind: 'subtitle',
      sourceText: s.text,
      translatedText: '',
      startMs: s.startMs,
      endMs: s.endMs,
      speaker: s.speakerId ? speakers.get(s.speakerId) : undefined,
      style: { fontSize: 14, color: '#182126', align: 'left' },
      review: [],
      stale: false,
      keepOriginal: true,
    })),
  };
}
