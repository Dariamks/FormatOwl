import { describe, it, expect } from 'vitest';
import {
  jobSpecSchema,
  fileCategory,
  fileTool,
  supportsInput,
  maxFileSize,
  mimeForName,
} from '@filemorph/core/domain';
import {
  videoConversionSchema,
  audioConversionSchema,
  imageConversionSchema,
} from '@filemorph/core/conversion';
import {
  chunkRanges,
  mergeChunkSegments,
  transcriptPatchSchema,
} from '@filemorph/core/transcription';
describe('Conversion boundaries', () => {
  it('separates recommendations from support and file limits', () => {
    expect(fileTool('photo.png')).toBe('image-compressor');
    expect(supportsInput('image-converter', 'photo.png')).toBe(true);
    expect(fileTool('photo.avif')).toBe('image-converter');
    expect(fileCategory('photo.avif')).toBe('image');
    expect(maxFileSize('image-converter')).toBe(50 * 1024 ** 2);
    expect(mimeForName('a.avif')).toBe('image/avif');
  });
  it('rejects incompatible encoders and injected commands', () => {
    for (const options of [
      { format: 'webm', codec: 'h264' },
      { format: 'mp4', codec: 'vp9' },
      { format: 'mp4', command: 'ffmpeg' },
      { format: 'mp4', fps: '-1' },
    ])
      expect(videoConversionSchema.safeParse(options).success).toBe(false);
    expect(
      jobSpecSchema.safeParse({ tool: 'image-converter', options: { format: 'mp4' } }).success,
    ).toBe(false);
  });
  it('checks sample rate and bitrate compatibility', () => {
    expect(audioConversionSchema.safeParse({ format: 'ogg' }).success).toBe(false);
    expect(
      audioConversionSchema.safeParse({ format: 'mp3', sampleRate: '22050', bitrate: 320 }).success,
    ).toBe(false);
    expect(
      audioConversionSchema.safeParse({ format: 'flac', sampleRate: '96000', bitDepth: 24 })
        .success,
    ).toBe(true);
    expect(imageConversionSchema.safeParse({ background: 'red;rm' }).success).toBe(false);
    expect(
      audioConversionSchema.safeParse({ format: 'aac', sampleRate: '22050', bitrate: 192 }).success,
    ).toBe(false);
    expect(
      audioConversionSchema.safeParse({
        format: 'm4a',
        sampleRate: '44100',
        bitrate: 320,
        channels: '1',
      }).success,
    ).toBe(false);
    expect(
      audioConversionSchema.safeParse({ format: 'aac', sampleRate: '22050', bitrate: 128 }).success,
    ).toBe(true);
  });
});
describe('Transcript timeline', () => {
  it('covers two hours with bounded chunks and continuous boundaries', () => {
    const chunks = chunkRanges(7200000, [589000, 1180000]);
    expect(chunks[0].endMs).toBe(589000);
    expect(chunks.at(-1)?.endMs).toBe(7200000);
    chunks.forEach((c, i) => {
      expect(c.endMs - c.startMs).toBeLessThanOrEqual(600000);
      if (i) expect(c.boundaryMs).toBe(chunks[i - 1].endMs);
    });
    expect(() => chunkRanges(7200001)).toThrow();
  });
  it('deduplicates an identical overlapping segment without merging speaker identities', () => {
    const a = { id: 'a', startMs: 598000, endMs: 600000, text: 'Hello!', speakerId: 'chunk-0-A' },
      b = { ...a, id: 'b', startMs: 599000, endMs: 601000, speakerId: 'chunk-1-A' };
    const segments = mergeChunkSegments([
      { range: { index: 0, startMs: 0, endMs: 600000, boundaryMs: 0 }, segments: [a] },
      { range: { index: 1, startMs: 599000, endMs: 1199000, boundaryMs: 600000 }, segments: [b] },
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].endMs).toBe(601000);
    expect(segments[0].speakerId).toBe('chunk-0-A');
  });
  it('rejects reversed timestamps and oversized edits', () => {
    expect(
      transcriptPatchSchema.safeParse({
        revision: 1,
        upsert: [{ id: 'a', startMs: 100, endMs: 10, text: 'a', speakerId: null }],
      }).success,
    ).toBe(false);
    expect(transcriptPatchSchema.safeParse({ revision: 1, command: 'rm' }).success).toBe(false);
  });
  it('trims a repeated phrase only across an overlapping chunk boundary', () => {
    const a = {
      id: 'a',
      startMs: 598000,
      endMs: 600000,
      text: '今天会议到这里结束。',
      speakerId: 'one',
    };
    const b = {
      ...a,
      id: 'b',
      startMs: 599000,
      endMs: 602000,
      text: '会议到这里结束。谢谢大家。',
      speakerId: 'two',
    };
    const result = mergeChunkSegments([
      { range: { index: 0, startMs: 0, endMs: 600000, boundaryMs: 0 }, segments: [a] },
      { range: { index: 1, startMs: 599000, endMs: 1199000, boundaryMs: 600000 }, segments: [b] },
    ]);
    expect(result[1]).toMatchObject({
      text: '谢谢大家。',
      startMs: 600000,
      endMs: 602000,
      speakerId: 'two',
    });
  });
});
