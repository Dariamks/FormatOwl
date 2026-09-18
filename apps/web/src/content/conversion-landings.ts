import {
  audioConversionSchema,
  imageConversionSchema,
  videoConversionSchema,
  type ConversionOptions,
  type ConversionTool,
} from '@filemorph/core/conversion';
import { toolContent, type ToolContent } from './tool-content';
export interface ConversionLanding {
  tool: ConversionTool;
  inputExtensions: string[];
  options: ConversionOptions;
  content: ToolContent;
}
export const conversionLandings: Record<string, ConversionLanding> = {
  'heic-to-jpg': {
    tool: 'image-converter',
    inputExtensions: ['heic'],
    options: imageConversionSchema.parse({ format: 'jpg' }),
    content: {
      ...toolContent['image-converter'],
      title: 'heic_to_jpg_converter_batch_convert_online_c746ed3',
      heading: 'heic_to_jpg_cbef36d',
      description: 'convert_heic_photos_to_jpg_in_batches_of_u_7dde7c9',
      input: 'HEIC',
      output: 'JPG',
      settings: 'jpg_is_selected_for_you_starting_at_qualit_6291a17',
      questions: [
        {
          question: 'why_can_the_jpg_be_larger_than_the_heic_7f3e21e',
          answer: 'these_formats_use_different_compression_me_96f76b4',
        },
      ],
      related: ['image-converter', 'image-compressor', 'webp-to-jpg'],
      guides: [],
    },
  },
  'webp-to-jpg': {
    tool: 'image-converter',
    inputExtensions: ['webp'],
    options: imageConversionSchema.parse({ format: 'jpg', background: '#ffffff' }),
    content: {
      ...toolContent['image-converter'],
      title: 'webp_to_jpg_converter_choose_your_backgrou_22aa02b',
      heading: 'webp_to_jpg_b9d912d',
      description: 'convert_webp_images_to_jpg_online_fill_tra_b123bcb',
      input: 'WebP',
      output: 'JPG',
      settings: 'the_starting_settings_are_jpg_quality_85_a_ad339f7',
      questions: [
        {
          question: 'can_jpg_keep_transparent_pixels_993869a',
          answer: 'jpg_has_no_transparency_channel_formatowl_14d6658',
        },
      ],
      related: ['image-converter', 'image-compressor', 'heic-to-jpg'],
      guides: ['webp-to-jpg-transparency'],
    },
  },
  'mov-to-mp4': {
    tool: 'video-converter',
    inputExtensions: ['mov'],
    options: videoConversionSchema.parse({ format: 'mp4', codec: 'h264' }),
    content: {
      ...toolContent['video-converter'],
      title: 'mov_to_mp4_converter_h_264_video_online_dd7235d',
      heading: 'mov_to_mp4_a07f7ee',
      description: 'convert_mov_videos_to_mp4_with_h_264_selec_75696ac',
      input: 'MOV',
      output: 'MP4',
      questions: [
        {
          question: 'will_iphone_hdr_video_work_8e7d148',
          answer: 'this_converter_currently_supports_sdr_only_668395d',
        },
      ],
      related: ['video-converter', 'video-compressor', 'video-to-mp3'],
      guides: ['compress-video-to-target-size'],
    },
  },
  'm4a-to-mp3': {
    tool: 'audio-converter',
    inputExtensions: ['m4a'],
    options: audioConversionSchema.parse({ format: 'mp3', bitrate: 192 }),
    content: {
      ...toolContent['audio-converter'],
      title: 'm4a_to_mp3_converter_batch_audio_conversio_25db195',
      heading: 'm4a_to_mp3_6c01603',
      description: 'convert_m4a_audio_to_mp3_online_starting_a_8a0cd72',
      input: 'M4A',
      output: 'MP3',
      settings: 'mp3_at_192_kbps_is_selected_initially_a_lo_28f6a32',
      related: ['audio-converter', 'audio-compressor', 'video-to-mp3'],
    },
  },
};
