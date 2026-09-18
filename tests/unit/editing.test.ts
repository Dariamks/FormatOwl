import { describe, it, expect } from 'vitest';
import { jobSpecSchema, supportsInput, fileTool, batchToolSchema } from '@filemorph/core/domain';
import { keptRanges, evenRect, editValidation, type EditorMedia } from '@filemorph/core/editing';
const id = '11111111-1111-4111-8111-111111111111';
const media: EditorMedia = {
  kind: 'video',
  duration: 60,
  origin: 0,
  width: 320,
  height: 240,
  codedWidth: 320,
  codedHeight: 240,
  rotation: 0,
  sar: 1,
  hdr: false,
  codec: 'h264',
  tracks: [
    {
      index: 1,
      codec: 'aac',
      sampleRate: 44100,
      channels: 2,
      start: 0,
      duration: 60,
      default: true,
    },
  ],
  defaultAudioIndex: 1,
};
describe('Editor boundaries', () => {
  it('allows a source in multiple tools without changing homepage dispatch or batch tools', () => {
    expect(fileTool('movie.mp4')).toBe('video-compressor');
    for (const tool of ['video-cutter', 'video-cropper', 'audio-cutter', 'video-to-mp3'] as const)
      expect(supportsInput(tool, 'movie.mp4')).toBe(true);
    expect(supportsInput('video-cutter', 'song.mp3')).toBe(false);
    expect(supportsInput('audio-cutter', 'ringtone.m4r')).toBe(true);
    expect(batchToolSchema.safeParse('audio-cutter').success).toBe(false);
  });
  it('accepts the three video output containers and legacy options, rejecting arbitrary formats', () => {
    for (const tool of ['video-cutter', 'video-cropper'] as const) {
      const base =
        tool === 'video-cutter'
          ? { mode: 'keep', ranges: [{ startMs: 0, endMs: 1000 }] }
          : { rect: { x: 0, y: 0, width: 100, height: 100 } };
      expect(jobSpecSchema.safeParse({ tool, options: base }).success).toBe(true);
      for (const format of ['mp4', 'mkv', 'mov'])
        expect(jobSpecSchema.parse({ tool, options: { ...base, format } }).options).toHaveProperty(
          'format',
          format,
        );
      for (const format of ['webm', 'avi', '-f matroska', ''])
        expect(jobSpecSchema.safeParse({ tool, options: { ...base, format } }).success).toBe(false);
    }
  });
  it('merges overlaps, sorts selections and calculates their complement', () => {
    const ranges = [
      { startMs: 400, endMs: 600 },
      { startMs: 100, endMs: 300 },
      { startMs: 250, endMs: 400 },
    ];
    expect(keptRanges(ranges, 'keep', 1000)).toEqual([{ startMs: 100, endMs: 600 }]);
    expect(keptRanges(ranges, 'remove', 1000)).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 600, endMs: 1000 },
    ]);
    expect(ranges[0].startMs).toBe(400);
    expect(
      editValidation('video-cutter', { mode: 'remove', ranges: [{ startMs: 0, endMs: 60000 }] }, [
        { id, media },
      ]),
    ).toBe('INVALID_RANGE');
  });
  it('rejects unknown commands, invalid times and overlapping fades', () => {
    for (const options of [
      { mode: 'keep', ranges: [{ startMs: 2, endMs: 1 }] },
      { mode: 'keep', ranges: [{ startMs: 0, endMs: 1 }], filter: 'movie=https://example.com' },
    ])
      expect(jobSpecSchema.safeParse({ tool: 'video-cutter', options }).success).toBe(false);
    expect(
      jobSpecSchema.safeParse({
        tool: 'audio-cutter',
        options: {
          clips: [
            { assetId: id, streamIndex: 1, startMs: 0, endMs: 1000, fadeInMs: 600, fadeOutMs: 600 },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it('checks coordinates, audio tracks, source membership, HDR and ringtone duration against metadata', () => {
    expect(evenRect({ x: 3, y: 7, width: 101, height: 51 })).toEqual({
      x: 2,
      y: 6,
      width: 100,
      height: 50,
    });
    expect(
      editValidation('video-cropper', { rect: { x: 100, y: 0, width: 300, height: 240 } }, [
        { id, media },
      ]),
    ).toBe('INVALID_CROP');
    expect(
      editValidation('video-to-mp3', { audioStreamIndex: 9, bitrate: 192 }, [{ id, media }]),
    ).toBe('AUDIO_TRACK_NOT_FOUND');
    expect(
      editValidation('video-cropper', { rect: { x: 0, y: 0, width: 320, height: 240 } }, [
        { id, media: { ...media, hdr: true } },
      ]),
    ).toBe('HDR_UNSUPPORTED');
    const options = {
      clips: [{ assetId: id, streamIndex: 1, startMs: 0, endMs: 31000, fadeInMs: 0, fadeOutMs: 0 }],
      format: 'm4r' as const,
      bitrate: 192 as const,
    };
    expect(editValidation('audio-cutter', options, [{ id, media }])).toBe('RINGTONE_TOO_LONG');
    expect(editValidation('audio-cutter', options, [{ id: 'other', media }])).toBe(
      'INVALID_SOURCES',
    );
  });
});
