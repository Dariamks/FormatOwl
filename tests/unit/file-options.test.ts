import { describe, it, expect } from 'vitest';
import { fileTool, jobSpecSchema, maxFileSize, mimeForName } from '@filemorph/core/domain';
describe('Multi-format trust boundary', () => {
  it('rejects mixing audio controls into image/PDF jobs and raw codec commands', () => {
    expect(() =>
      jobSpecSchema.parse({ tool: 'image-compressor', options: { format: 'mp3' } }),
    ).toThrow();
    expect(() =>
      jobSpecSchema.parse({ tool: 'pdf-compressor', options: { command: 'anything' } }),
    ).toThrow();
    expect(() =>
      jobSpecSchema.parse({
        tool: 'audio-compressor',
        options: { format: 'aac;exit', sampleRate: '96000' },
      }),
    ).toThrow();
  });
  it('allows only known extensions and safe filenames, with type-specific limits', () => {
    expect(fileTool('PHOTO.HEIC')).toBe('image-compressor');
    expect(fileTool('book.PDF')).toBe('pdf-compressor');
    expect(fileTool('drawing.svg')).toBe('image-translator');
    expect(fileTool('book.epub')).toBe('document-translator');
    for (const name of ['../photo.png', 'a\\b.pdf', 'a\n.mp3', 'stream.m3u8'])
      expect(fileTool(name)).toBeUndefined();
    expect(maxFileSize('pdf-compressor')).toBe(50 * 1024 ** 2);
    expect(maxFileSize('audio-compressor')).toBe(1024 ** 3);
    expect(mimeForName('song.m4a')).toBe('audio/mp4');
    expect(mimeForName('photo.heic')).toBe('image/heic');
  });
});
