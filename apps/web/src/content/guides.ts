import { type Copy } from './tool-content';
export interface Guide {
  title: Copy;
  description: Copy;
  updated: string;
  sections: { heading: Copy; paragraphs: Copy[] }[];
  example: { caption: Copy; columns: Copy[]; rows: string[][]; note: Copy };
  tools: string[];
}
export const guides: Record<string, Guide> = {
  'compress-video-to-target-size': {
    title: 'how_to_compress_a_video_to_a_target_file_s_f4c319e',
    description: 'choose_a_video_size_budget_understand_bitr_3be295f',
    updated: '2026-09-16',
    sections: [
      {
        heading: 'start_with_the_upload_limit_and_duration_3b057c1',
        paragraphs: [
          'if_a_destination_has_a_strict_limit_leave_3a65e2e',
          'formatowl_s_target_size_field_uses_mib_int_301e5ff',
        ],
      },
      {
        heading: 'choose_the_settings_in_formatowl_af431c8',
        paragraphs: [
          'open_video_compressor_and_upload_mp4_mov_m_14fb53f',
          'target_mode_runs_two_encoding_passes_its_r_f5d7c76',
        ],
      },
      {
        heading: 'compare_the_output_not_just_the_number_d6a60d0',
        paragraphs: [
          'compare_fast_motion_small_text_and_dark_sc_cee6aad',
          'changing_the_container_alone_does_not_guar_db4b4ae',
        ],
      },
    ],
    example: {
      caption: 'measured_synthetic_motion_sample_c35bf77',
      columns: ['input_b568d47', 'settings_c7f73bb', 'output_4bed336'],
      rows: [['measuredRow0', 'measuredRow1', 'measuredRow2']],
      note: 'measured_locally_on_september_16_2026_with_63b76d9',
    },
    tools: ['video-compressor', 'video-converter', 'mov-to-mp4'],
  },
  'webp-to-jpg-transparency': {
    title: 'webp_to_jpg_what_happens_to_a_transparent_2c3b9f6',
    description: 'learn_why_jpg_needs_a_background_color_cho_a4646d9',
    updated: '2026-09-16',
    sections: [
      {
        heading: 'jpg_cannot_retain_transparency_8697e64',
        paragraphs: [
          'webp_can_store_transparent_and_partly_tran_afe1ec0',
          'choose_png_or_webp_output_in_the_general_i_7bc2f14',
        ],
      },
      {
        heading: 'choose_the_background_before_converting_202f693',
        paragraphs: [
          'the_webp_to_jpg_page_starts_with_a_white_b_6f9ae44',
          'inspect_the_edges_of_text_and_logos_in_the_f2ec21d',
        ],
      },
      {
        heading: 'check_animation_and_file_size_b51105b',
        paragraphs: [
          'for_animated_webp_jpg_output_requires_expl_ff9d26c',
          'jpg_is_useful_for_compatibility_but_can_be_692f3f1',
        ],
      },
    ],
    example: {
      caption: 'measured_transparency_conversion_07e1be7',
      columns: ['input_b568d47', 'settings_c7f73bb', 'output_4bed336'],
      rows: [['measuredRow3', 'measuredRow4', 'measuredRow5']],
      note: 'a_synthetic_transparent_canvas_with_a_blue_a6717dd',
    },
    tools: ['webp-to-jpg', 'image-converter', 'image-compressor'],
  },
  'why-pdf-wont-compress': {
    title: 'why_is_my_pdf_still_large_after_compressio_2a1c313',
    description: 'understand_text_heavy_and_scanned_pdfs_cho_3899a6b',
    updated: '2026-09-16',
    sections: [
      {
        heading: 'a_pdf_can_contain_very_different_kinds_of_8103e22',
        paragraphs: [
          'a_short_text_document_can_already_be_small_de9178f',
          'our_synthetic_scan_below_is_a_full_page_im_1b77d5a',
        ],
      },
      {
        heading: 'use_the_preset_that_matches_the_document_b5d6c57',
        paragraphs: [
          'light_optimizes_structure_balanced_and_str_794ba35',
          'compression_retains_existing_text_but_does_5819936',
        ],
      },
      {
        heading: 'know_when_to_keep_the_original_ede8d41',
        paragraphs: [
          'previously_optimized_files_may_have_little_036ae7b',
          'encrypted_and_digitally_signed_pdfs_are_re_2baa85b',
        ],
      },
    ],
    example: {
      caption: 'two_one_page_pdfs_same_strong_preset_8ee4b65',
      columns: ['sample_58fabfa', 'input_bytes_7af5021', 'output_bytes_d29fc70'],
      rows: [
        ['measuredRow6', '1,578', '1,147'],
        ['measuredRow7', '1,590,807', '531,720'],
      ],
      note: 'measured_locally_on_september_16_2026_with_c1e1cb4',
    },
    tools: ['pdf-compressor', 'image-compressor'],
  },
};
