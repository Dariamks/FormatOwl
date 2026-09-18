'use client';
import dynamic from 'next/dynamic';
// Keep the route's client references small. Only the rendered tool fetches its code.
export const WatermarkEntry = dynamic(() => import('./watermark-entry'));
export const TranslationEntry = dynamic(() => import('./translation-entry'));
export const TranscriptionEntry = dynamic(() => import('./transcription-entry'));
export const EditorEntry = dynamic(() => import('./editor-entry'));
export const BatchCompressor = dynamic(() =>
  import('./batch-compressor').then((m) => m.BatchCompressor),
);
export const Compressor = dynamic(() => import('./compressor').then((m) => m.Compressor));
