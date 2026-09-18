'use client';
import type {
  AudioConversionOptions,
  ConversionOptions,
  ConversionTool,
  ImageConversionOptions,
  VideoConversionOptions,
} from '@filemorph/core/conversion';
import { supportedAudioBitrates } from '@filemorph/core/conversion';
import { useTranslations } from 'next-intl';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { SettingsTabs } from './ui/settings-tabs';
export function ConversionSettings({
  tool,
  value,
  onChange,
  disabled = false,
  fixedOutputFormat,
}: {
  tool: ConversionTool;
  value: ConversionOptions;
  onChange: (v: ConversionOptions) => void;
  disabled?: boolean;
  fixedOutputFormat?: ConversionOptions['format'];
}) {
  const copy = useTranslations('conversion');

  const field = (
    label: string,
    current: string,
    items: [string, string][],
    set: (v: string) => void,
    locked = false,
  ) => (
    <div>
      <label className="label" htmlFor={`convert-${label}`}>
        {label}
      </label>
      <Select disabled={disabled || locked} value={current} onValueChange={set}>
        <SelectTrigger id={`convert-${label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  const pairs = (values: string[]) => values.map((v) => [v, v.toUpperCase()] as [string, string]);
  if (tool === 'video-converter') {
    const o = value as VideoConversionOptions;
    const set = (v: Partial<VideoConversionOptions>) => onChange({ ...o, ...v });
    return (
      <div className="conversion-options">
        <SettingsTabs
          label={copy('conversion_settings_a92dd86')}
          basicLabel={copy('basic_conversion_4a9e0cb')}
          advancedLabel={copy('advanced_conversion_201f014')}
          disabled={disabled}
          common={field(
            copy('output_format_c03f08a'),
            o.format,
            pairs(['mp4', 'mov', 'mkv', 'webm']),
            (v) =>
              set({
                format: v as typeof o.format,
                codec: v === 'webm' ? 'vp9' : o.codec === 'vp9' ? 'h264' : o.codec,
              }),
            Boolean(fixedOutputFormat),
          )}
          basic={
            <p className="settings-intro">
              {fixedOutputFormat
                ? copy('the_output_format_is_selected_use_advanced_c3c038a')
                : copy('choose_a_format_to_get_started_use_advance_6f4c0e4')}
            </p>
          }
          advanced={
            <div className="form-grid">
              {field(
                copy('video_codec_534048d'),
                o.codec,
                pairs(o.format === 'webm' ? ['vp9'] : ['h264', 'h265']),
                (v) => set({ codec: v as typeof o.codec }),
              )}
              {field(
                copy('quality_a60f2c7'),
                o.quality,
                [
                  ['high', copy('high_quality_f82bab7')],
                  ['balanced', copy('balanced_03342db')],
                  ['small', copy('smaller_file_37bd1b6')],
                ],
                (v) => set({ quality: v as typeof o.quality }),
              )}
              {field(
                copy('resolution_516aae5'),
                o.resolution,
                [
                  ['original', copy('original_c0a8060')],
                  ...['480', '720', '1080', '2160'].map((v) => [v, `${v}p`] as [string, string]),
                ],
                (v) => set({ resolution: v as typeof o.resolution }),
              )}
              {field(
                copy('frame_rate_a245d87'),
                o.fps,
                [
                  ['original', copy('original_c0a8060')],
                  ...['24', '25', '30', '50', '60'].map((v) => [v, `${v} fps`] as [string, string]),
                ],
                (v) => set({ fps: v as typeof o.fps }),
              )}
            </div>
          }
        />
        <p className="field-help">{copy('converts_the_main_video_and_default_audio_ace7dcd')}</p>
      </div>
    );
  }
  if (tool === 'audio-converter') {
    const o = value as AudioConversionOptions;
    const set = (v: Partial<AudioConversionOptions>) => {
      const next = { ...o, ...v };
      const bitrates = supportedAudioBitrates(next);
      if (!bitrates.includes(next.bitrate)) next.bitrate = bitrates.at(-1)!;
      onChange(next);
    };
    const lossless = ['wav', 'flac'].includes(o.format);
    return (
      <div className="conversion-options">
        <SettingsTabs
          label={copy('conversion_settings_a92dd86')}
          basicLabel={copy('basic_conversion_4a9e0cb')}
          advancedLabel={copy('advanced_conversion_201f014')}
          disabled={disabled}
          common={field(
            copy('output_format_c03f08a'),
            o.format,
            ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'].map((v) => [
              v,
              v === 'ogg' ? 'OGG (Opus)' : v.toUpperCase(),
            ]),
            (v) =>
              set({
                format: v as typeof o.format,
                sampleRate:
                  v === 'ogg'
                    ? '48000'
                    : !['wav', 'flac'].includes(v) && o.sampleRate === '96000'
                      ? '44100'
                      : o.sampleRate,
                bitrate: v === 'mp3' && o.sampleRate === '22050' ? 128 : o.bitrate,
              }),
            Boolean(fixedOutputFormat),
          )}
          basic={
            <p className="settings-intro">
              {fixedOutputFormat
                ? copy('the_output_format_is_selected_use_advanced_c3c038a')
                : copy('choose_a_format_to_get_started_use_advance_6f4c0e4')}
            </p>
          }
          advanced={
            <div className="form-grid">
              {!lossless &&
                field(
                  copy('bitrate_d153e75'),
                  String(o.bitrate),
                  supportedAudioBitrates(o).map((v) => [String(v), `${v} kbps`]),
                  (v) => set({ bitrate: Number(v) as typeof o.bitrate }),
                )}
              {field(
                copy('sample_rate_7a03162'),
                o.sampleRate,
                (o.format === 'ogg'
                  ? ['48000']
                  : lossless
                    ? ['22050', '32000', '44100', '48000', '96000']
                    : ['22050', '32000', '44100', '48000']
                ).map((v) => [v, `${v} Hz`]),
                (v) =>
                  set({
                    sampleRate: v as typeof o.sampleRate,
                    bitrate:
                      o.format === 'mp3' && v === '22050' && o.bitrate > 160 ? 128 : o.bitrate,
                  }),
              )}
              {field(
                copy('channels_18e03e2'),
                o.channels,
                [
                  ['auto', copy('keep_mono_stereo_0b3b84e')],
                  ['1', copy('mono_c5c5533')],
                  ['2', copy('stereo_f4f390b')],
                ],
                (v) => set({ channels: v as typeof o.channels }),
              )}
              {lossless &&
                field(
                  copy('bit_depth_ee8ea2f'),
                  String(o.bitDepth),
                  [
                    ['16', '16-bit'],
                    ['24', '24-bit'],
                  ],
                  (v) => set({ bitDepth: Number(v) as 16 | 24 }),
                )}
            </div>
          }
        />
        <p className="field-help">{copy('aac_uses_adts_m4a_contains_aac_wav_and_fla_6700b67')}</p>
      </div>
    );
  }
  const o = value as ImageConversionOptions;
  const set = (v: Partial<ImageConversionOptions>) => onChange({ ...o, ...v });
  return (
    <div className="conversion-options">
      <SettingsTabs
        label={copy('conversion_settings_a92dd86')}
        basicLabel={copy('basic_conversion_4a9e0cb')}
        advancedLabel={copy('advanced_conversion_201f014')}
        disabled={disabled}
        common={field(
          copy('output_format_c03f08a'),
          o.format,
          pairs(['jpg', 'png', 'webp', 'avif']),
          (v) => set({ format: v as typeof o.format, quality: undefined }),
          Boolean(fixedOutputFormat),
        )}
        basic={
          <p className="settings-intro">
            {fixedOutputFormat
              ? copy('the_output_format_is_selected_use_advanced_c3c038a')
              : copy('choose_a_format_to_get_started_use_advance_6f4c0e4')}
          </p>
        }
        advanced={
          <div className="form-grid">
            {o.format !== 'png' && (
              <div>
                <label className="label" htmlFor="image-quality">
                  {copy('quality_a60f2c7')}
                </label>
                <input
                  id="image-quality"
                  className="field"
                  disabled={disabled}
                  type="number"
                  min={1}
                  max={100}
                  value={o.quality ?? { jpg: 85, webp: 80, avif: 50 }[o.format]}
                  onChange={(e) => set({ quality: Number(e.target.value) })}
                />
              </div>
            )}
            {o.format === 'jpg' && (
              <div>
                <label className="label" htmlFor="image-background">
                  {copy('background_color_1a0371e')}
                </label>
                <input
                  id="image-background"
                  className="field color-field"
                  disabled={disabled}
                  type="color"
                  value={o.background}
                  onChange={(e) => set({ background: e.target.value })}
                />
              </div>
            )}
            <label className="checkbox-label conversion-first-frame">
              <input
                disabled={disabled}
                type="checkbox"
                checked={o.firstFrame}
                onChange={(e) => set({ firstFrame: e.target.checked })}
              />
              {copy('convert_only_the_first_animation_frame_f87e76c')}
            </label>
          </div>
        }
      />
      <p className="field-help">{copy('webp_can_keep_animations_other_outputs_req_1482f5f')}</p>
    </div>
  );
}
