export type Copy = string;
export interface ToolContent {
  title: Copy;
  heading: Copy;
  description: Copy;
  input: string;
  output: string;
  limits: Copy;
  settings: Copy;
  steps: Copy[];
  questions: { question: Copy; answer: Copy }[];
  related: string[];
  guides: string[];
}
const batchSteps = [
  'choose_up_to_20_supported_files_every_file_d0b7186',
  'adjust_the_settings_and_start_processing_k_df5b7de',
  'preview_the_results_download_individual_fi_d5121b9',
];
const mediaLimit = 'up_to_1_gib_per_file_and_20_files_per_batc_b38714c';
const imageLimit = 'up_to_50_mib_per_file_and_20_files_per_bat_1deca75';
export const toolContent = {
  'video-compressor': {
    title: 'online_video_compressor_mp4_mov_webm_8af5ab7',
    heading: 'video_compressor_4ebae84',
    description: 'reduce_mp4_mov_mkv_and_webm_video_size_onl_cc907e4',
    input: 'MP4 · MOV · MKV · WebM',
    output: 'MP4 (H.264 / H.265)',
    limits: 'one_video_at_a_time_up_to_1_gib_a_target_t_d7f0daa',
    settings: 'start_with_balanced_use_h_264_for_broad_pl_c42485d',
    steps: [
      'choose_a_supported_video_and_wait_for_its_9bff92c',
      'select_quality_or_enter_a_target_size_in_a_4d700aa',
      'compare_the_original_and_result_then_downl_fe994a1',
    ],
    questions: [
      {
        question: 'will_compression_keep_exactly_the_same_qua_f878c5f',
        answer: 're_encoding_is_lossy_smaller_targets_can_r_e0a2a09',
      },
      {
        question: 'can_i_close_the_page_efea5d8',
        answer: 'after_upload_and_task_submission_finish_pr_045ab5b',
      },
    ],
    related: ['video-converter', 'mov-to-mp4', 'video-to-mp3'],
    guides: ['compress-video-to-target-size'],
  },
  'image-compressor': {
    title: 'online_image_compressor_batch_jpg_png_webp_c880d3b',
    heading: 'image_compressor_8c267c6',
    description: 'compress_jpg_png_webp_gif_and_heic_images_ce420fe',
    input: 'JPG / JPEG · PNG · WebP · GIF · HEIC',
    output: 'JPG / JPEG · PNG · WebP · GIF · HEIC',
    limits: imageLimit,
    settings: 'balanced_is_the_starting_preset_stronger_c_a981a23',
    steps: batchSteps,
    questions: [
      {
        question: 'what_if_the_image_is_already_optimized_8128ae2',
        answer: 'if_a_smaller_safe_result_cannot_be_produce_cdbacc3',
      },
      {
        question: 'are_all_animated_or_heic_files_supported_deef737',
        answer: 'apng_is_unsupported_animations_are_limited_cce558d',
      },
    ],
    related: ['image-converter', 'heic-to-jpg', 'webp-to-jpg'],
    guides: ['webp-to-jpg-transparency'],
  },
  'pdf-compressor': {
    title: 'online_pdf_compressor_reduce_pdf_size_40de7e0',
    heading: 'pdf_compressor_f3df373',
    description: 'reduce_pdf_size_with_light_balanced_or_str_4e04685',
    input: 'PDF',
    output: 'PDF',
    limits: 'up_to_50_mib_and_1_000_pages_per_file_20_f_cece71d',
    settings: 'light_optimizes_structure_balanced_and_str_5865b1a',
    steps: batchSteps,
    questions: [
      {
        question: 'why_did_the_pdf_not_become_smaller_a9c8b86',
        answer: 'text_heavy_or_previously_optimized_files_c_7440314',
      },
      {
        question: 'does_this_certify_pdf_a_or_preserve_every_a242405',
        answer: 'no_review_forms_colors_and_important_pages_28a6429',
      },
    ],
    related: ['image-compressor', 'video-compressor'],
    guides: ['why-pdf-wont-compress'],
  },
  'audio-compressor': {
    title: 'online_audio_compressor_mp3_wav_m4a_flac_347f792',
    heading: 'audio_compressor_1200254',
    description: 'reduce_audio_size_by_adjusting_bitrate_sam_19b868a',
    input: 'MP3 · WAV · AAC · M4A · FLAC · OGG',
    output: 'MP3 · M4A (AAC)',
    limits: 'up_to_1_gib_per_file_and_20_files_per_batc_80a6b51',
    settings: 'try_192_kbps_for_a_starting_comparison_128_f5d6bb9',
    steps: batchSteps,
    questions: [
      {
        question: 'can_compressed_audio_become_larger_0f6cd8f',
        answer: 'yes_an_already_low_bitrate_input_can_be_sm_2c193b4',
      },
    ],
    related: ['audio-converter', 'm4a-to-mp3', 'video-to-mp3'],
    guides: [],
  },
  'video-converter': {
    title: 'online_video_converter_mp4_mov_mkv_webm_fea0f49',
    heading: 'convert_video_746c932',
    description: 'batch_convert_mp4_mov_mkv_and_webm_videos_19d07df',
    input: 'MP4 · MOV · MKV · WebM',
    output: 'MP4 · MOV · MKV · WebM',
    limits: mediaLimit,
    settings: 'mp4_with_h_264_is_the_default_webm_uses_vp_498ca58',
    steps: batchSteps,
    questions: [
      {
        question: 'is_conversion_just_a_filename_change_77e9d69',
        answer: 'no_the_video_is_decoded_and_encoded_into_t_ffbcd7c',
      },
    ],
    related: ['mov-to-mp4', 'video-compressor', 'video-to-mp3'],
    guides: ['compress-video-to-target-size'],
  },
  'audio-converter': {
    title: 'online_audio_converter_mp3_wav_m4a_flac_58409f6',
    heading: 'convert_audio_ac395bf',
    description: 'batch_convert_mp3_wav_aac_m4a_flac_and_ogg_320a830',
    input: 'MP3 · WAV · AAC · M4A · FLAC · OGG',
    output: 'MP3 · WAV · AAC · M4A · FLAC · OGG (Opus)',
    limits: mediaLimit,
    settings: 'mp3_at_192_kbps_is_the_default_wav_and_fla_d76b0e1',
    steps: batchSteps,
    questions: [
      {
        question: 'will_converting_mp3_to_flac_improve_the_so_11c80b0',
        answer: 'no_lossless_output_does_not_recover_inform_9d697de',
      },
    ],
    related: ['m4a-to-mp3', 'audio-compressor', 'video-to-mp3'],
    guides: [],
  },
  'image-converter': {
    title: 'online_image_converter_jpg_png_webp_avif_h_d1fb0af',
    heading: 'convert_image_b6b8535',
    description: 'convert_jpg_png_webp_avif_gif_and_heic_to_0f8b4e3',
    input: 'JPG / JPEG · PNG · WebP · AVIF · GIF · HEIC',
    output: 'JPG · PNG · WebP · AVIF',
    limits: imageLimit,
    settings: 'png_is_the_default_jpg_fills_transparency_d582774',
    steps: batchSteps,
    questions: [
      {
        question: 'does_the_output_retain_exif_metadata_ff5df0e',
        answer: 'the_conversion_output_does_not_retain_exif_6b94ada',
      },
    ],
    related: ['heic-to-jpg', 'webp-to-jpg', 'image-compressor'],
    guides: ['webp-to-jpg-transparency'],
  },
  'video-to-mp3': {
    title: 'video_to_mp3_converter_extract_audio_onlin_4766c37',
    heading: 'video_to_mp3_a6c0fde',
    description: 'extract_mp3_audio_from_mp4_mov_mkv_or_webm_8a59025',
    input: 'MP4 · MOV · MKV · WebM',
    output: 'MP3',
    limits: 'input_files_total_up_to_1_gib_the_video_mu_1d6d2ed',
    settings: 'select_the_audio_track_you_need_and_option_125e119',
    steps: [
      'upload_a_video_with_audio_and_let_the_prev_f4fb0e4',
      'choose_the_track_time_range_and_mp3_bitrat_8f868bb',
      'preview_export_and_download_the_audio_ef35ea7',
    ],
    questions: [
      {
        question: 'can_i_extract_audio_from_a_silent_video_30527ab',
        answer: 'a_video_without_an_audio_track_cannot_prod_12d5e6b',
      },
    ],
    related: ['audio-cutter', 'audio-converter', 'audio-compressor'],
    guides: [],
  },
  'video-cutter': {
    title: 'online_video_trimmer_cut_mp4_mov_mkv_webm_0444685',
    heading: 'trim_video_373c6bf',
    description: 'trim_a_video_with_a_visual_timeline_keep_o_86835bb',
    input: 'MP4 · MOV · MKV · WebM',
    output: 'MP4 · MOV · MKV',
    limits: 'one_video_up_to_1_gib_with_up_to_50_segmen_84ff650',
    settings: 'set_precise_start_and_end_times_or_use_the_3fc2036',
    steps: [
      'upload_and_prepare_the_preview_695337c',
      'select_ranges_to_keep_or_remove_071a05e',
      'preview_the_edit_and_export_ec39327',
    ],
    questions: [],
    related: ['video-cropper', 'video-compressor', 'video-to-mp3'],
    guides: [],
  },
  'video-cropper': {
    title: 'online_video_cropper_adjust_aspect_ratio_f_f8451db',
    heading: 'crop_video_77dd683',
    description: 'crop_the_picture_of_mp4_mov_mkv_or_webm_vi_d2d6ba3',
    input: 'MP4 · MOV · MKV · WebM',
    output: 'MP4 · MOV · MKV',
    limits: 'one_video_up_to_1_gib_sdr_only_cropping_re_c0e1190',
    settings: 'use_a_fixed_ratio_for_a_specific_screen_or_3142bca',
    steps: [
      'upload_the_video_and_prepare_its_preview_ea63aa7',
      'drag_and_resize_the_crop_box_or_enter_dime_ed68371',
      'preview_the_composition_and_export_a77da81',
    ],
    questions: [],
    related: ['video-cutter', 'video-compressor'],
    guides: [],
  },
  'audio-cutter': {
    title: 'online_audio_editor_trim_join_fade_audio_87d1429',
    heading: 'edit_audio_4510d20',
    description: 'trim_and_arrange_audio_clips_using_a_wavef_99b4f2a',
    input: 'MP3 · WAV · AAC · M4A · FLAC · OGG · MP4 · MOV · MKV · WebM',
    output: 'MP3 · WAV · M4A · M4R',
    limits: 'up_to_20_source_files_50_segments_and_1_gi_5ec9378',
    settings: 'arrange_segments_sequentially_and_add_fade_1bb29fd',
    steps: [
      'upload_supported_audio_or_video_sources_c35ba1a',
      'trim_arrange_and_preview_the_clips_f6c0f98',
      'choose_a_format_and_export_the_complete_ed_acc627a',
    ],
    questions: [],
    related: ['audio-converter', 'audio-compressor', 'video-to-mp3'],
    guides: [],
  },
} satisfies Record<string, ToolContent>;
export type PublishedTool = keyof typeof toolContent;
