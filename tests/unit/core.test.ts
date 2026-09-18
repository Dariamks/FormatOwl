import { describe, it, expect } from 'vitest';
import { compressionSchema, validateVideoName, outputFilename } from '@filemorph/core/domain';
import { newSession, verifySession } from '@filemorph/core/session';
import { encodingPasses, MediaError } from '@filemorph/core/media';
const media = {
  duration: 120,
  width: 1920,
  height: 1080,
  codec: 'h264',
  hasAudio: true,
  rotation: 0,
};
describe('Untrusted processing parameters', () => {
  it('rejects unknown fields and command fragments', () => {
    expect(() => compressionSchema.parse({ codec: 'h264; rm -rf /' })).toThrow();
    expect(() => compressionSchema.parse({ filter: 'movie=https://example.com' })).toThrow();
  });
  it('rejects nonfinite or out-of-range settings', () => {
    for (const options of [
      { targetMb: 0 },
      { crf: Infinity },
      { resolution: '99999' },
      { maxBitrateKbps: -10 },
    ])
      expect(() => compressionSchema.parse(options)).toThrow();
  });
  it('checks extensions and control characters', () => {
    expect(validateVideoName('hello.MOV')).toBe(true);
    expect(validateVideoName('playlist.m3u8')).toBe(false);
    expect(validateVideoName('bad\n.mp4')).toBe(false);
    expect(outputFilename('旅行.mp4')).toBe('旅行-formatowl.mp4');
  });
});
describe('Anonymous session integrity', () => {
  it('accepts a valid signed session, rejects forgery and malformed values', () => {
    const secret = 'a'.repeat(32);
    const session = newSession(secret);
    expect(verifySession(session.token, secret)).toBe(session.owner.slice(5));
    expect(verifySession(session.token + 'x', secret)).toBeNull();
    expect(verifySession(session.token, 'b'.repeat(32))).toBeNull();
    expect(verifySession('bad', secret)).toBeNull();
  });
});
describe('Encoding behavior', () => {
  it('limits input protocols and preserves optional audio without requiring it', () => {
    const [args] = encodingPasses(
      '/tmp/unsafe;file.mp4',
      '/tmp/out.mp4',
      compressionSchema.parse({}),
      media,
      '/tmp/job',
    );
    expect(args).toContain('file,pipe');
    expect(args).toContain('mov,matroska,webm');
    expect(args).toContain('0:a:0?');
    expect(args).toContain('/tmp/unsafe;file.mp4');
    expect(args).toContain('yuv420p');
  });
  it('uses two passes for a target size and reserves audio bitrate', () => {
    const passes = encodingPasses(
      '/tmp/in',
      '/tmp/out',
      compressionSchema.parse({ targetMb: 8 }),
      media,
      '/tmp/job',
    );
    expect(passes).toHaveLength(2);
    expect(passes[0]).toContain('-an');
    expect(passes[1]).toContain('414k');
    expect(passes[1]).not.toContain('-crf');
  });
  it('fails an impossible target instead of silently exceeding it', () => {
    expect(() =>
      encodingPasses('i', 'o', compressionSchema.parse({ targetMb: 0.1 }), media, '/tmp'),
    ).toThrow(MediaError);
  });
  it('uses a distinct x265 two-pass configuration', () => {
    const passes = encodingPasses(
      'i',
      'o',
      compressionSchema.parse({ codec: 'h265', targetMb: 8 }),
      media,
      '/tmp/job',
    );
    expect(passes[0].join(' ')).toContain('pass=1:stats=/tmp/job/pass');
    expect(passes[1]).toContain('hvc1');
  });
});
