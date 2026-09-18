export const tools = [
  {
    id: 'image-watermark-remover',
    group: 'image',
    icon: 'eraser',
    ready: true,

    formats: 'JPG · PNG · WebP',
  },
  {
    id: 'pdf-watermark-remover',
    group: 'document',
    icon: 'eraser',
    ready: true,

    formats: 'PDF',
  },
  {
    id: 'word-watermark-remover',
    group: 'document',
    icon: 'eraser',
    ready: true,

    formats: 'DOCX',
  },
  {
    id: 'ppt-watermark-remover',
    group: 'document',
    icon: 'eraser',
    ready: true,

    formats: 'PPTX',
  },
  {
    id: 'video-compressor',
    group: 'video',
    icon: 'video',
    ready: true,

    formats: 'MP4 · MOV · MKV · WebM',
  },
  {
    id: 'image-compressor',
    group: 'image',
    icon: 'image',
    ready: true,

    formats: 'JPG · PNG · WebP · GIF · HEIC',
  },
  {
    id: 'pdf-compressor',
    group: 'document',
    icon: 'file',
    ready: true,

    formats: 'PDF',
  },
  {
    id: 'audio-compressor',
    group: 'audio',
    icon: 'audio',
    ready: true,

    formats: 'MP3 · WAV · M4A · FLAC',
  },
  {
    id: 'video-cutter',
    group: 'video',
    icon: 'scissors',
    ready: true,

    formats: 'MP4 · MOV · MKV · WebM',
  },
  {
    id: 'video-cropper',
    group: 'video',
    icon: 'crop',
    ready: true,

    formats: 'MP4 · MOV · MKV · WebM',
  },
  {
    id: 'audio-cutter',
    group: 'audio',
    icon: 'scissors',
    ready: true,

    formats: 'MP3 · WAV · M4A · M4R',
  },
  {
    id: 'video-to-mp3',
    group: 'audio',
    icon: 'audio',
    ready: true,

    formats: 'MP4 · MOV · MKV · WebM → MP3',
  },
  {
    id: 'video-converter',
    group: 'video',
    icon: 'convert',
    ready: true,

    formats: 'MP4 · MOV · MKV · WebM',
  },
  {
    id: 'audio-converter',
    group: 'audio',
    icon: 'convert',
    ready: true,

    formats: 'MP3 · WAV · AAC · M4A · FLAC · OGG (Opus)',
  },
  {
    id: 'image-converter',
    group: 'image',
    icon: 'convert',
    ready: true,

    formats: 'JPG · PNG · WebP · AVIF',
  },
  {
    id: 'transcription',
    group: 'ai',
    icon: 'text',
    ready: true,

    formats: 'TXT · DOCX · PDF · SRT · VTT',
  },
  {
    id: 'video-translator',
    group: 'ai',
    icon: 'languages',
    ready: true,

    formats: 'SRT · VTT · ASS · MP4',
  },
  {
    id: 'document-translator',
    group: 'ai',
    icon: 'languages',
    ready: true,

    formats: 'PDF · DOCX · TXT · EPUB',
  },
  {
    id: 'image-translator',
    group: 'ai',
    icon: 'languages',
    ready: true,

    formats: 'JPG · PNG · WebP · SVG',
  },
] as const;
export type Tool = (typeof tools)[number];
