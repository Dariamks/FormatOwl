import type { Namespace } from './imports';
/** Client-only UI dependencies. Long-form content and email stay on the server. */
export function toolNamespaces(tool: string): Namespace[] {
  if (tool.includes('watermark')) return ['watermark', 'tools', 'billing'];
  if (tool.includes('translator')) return ['translation', 'reading', 'preview', 'billing'];
  if (tool === 'transcription') return ['transcription', 'reading', 'workspace', 'billing'];
  if (/cutter|cropper|video-to-mp3/.test(tool)) return ['media', 'tools', 'workspace', 'billing'];
  if (tool === 'video-compressor')
    return ['compress', 'conversion', 'workspace', 'billing', 'homeExtra', 'examples'];
  return [
    'compress',
    'batch',
    'conversion',
    'preview',
    'tools',
    'workspace',
    'billing',
    'homeExtra',
    'examples',
  ];
}

/** Creation forms do not render the review/reading workspace yet. */
export function entryNamespaces(tool: string): Namespace[] {
  if (tool.includes('translator')) return ['translation', 'billing'];
  if (tool === 'transcription') return ['transcription', 'billing'];
  return toolNamespaces(tool);
}
