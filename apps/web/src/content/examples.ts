import type { CompressionOptions } from '@filemorph/core/domain';
import type { ImageConversionOptions } from '@filemorph/core/conversion';
import sizes from '../../public/examples/sizes.json';
type Copy = string;
type Asset = { url: string; name: string; mime: string; size: number; preview?: string };
type Base = {
  id: string;
  route: string;
  title: Copy;
  scenario: Copy;
  description: Copy;
  settings: Copy;
  input: Asset;
  output: Asset;
};
export type PublicExample = Base &
  (
    | { kind: 'video'; tool: 'video-compressor'; options: CompressionOptions }
    | { kind: 'image'; tool: 'image-converter'; options: ImageConversionOptions }
    | { kind: 'pdf'; tool: 'pdf-compressor'; options: { preset: 'strong' } }
  );
export const publicExamples: PublicExample[] = [
  {
    id: 'video',
    kind: 'video',
    tool: 'video-compressor',
    route: 'video-compressor',
    title: 'video_compression_09eeacf',
    scenario: 'a_lighter_way_to_share_a331933',
    description: 'an_original_eight_second_motion_study_comp_490dace',
    settings: 'balanced_h_264_original_resolution_no_audi_6a5268a',
    options: { preset: 'balanced', codec: 'h264', resolution: 'original', speed: 'medium' },
    input: {
      url: '/examples/studio-original.mp4',
      name: 'studio-original.mp4',
      mime: 'video/mp4',
      size: sizes.video.inputBytes,
      preview: '/examples/video-poster.webp',
    },
    output: {
      url: '/examples/studio-compressed.mp4',
      name: 'studio-compressed.mp4',
      mime: 'video/mp4',
      size: sizes.video.outputBytes,
      preview: '/examples/video-poster.webp',
    },
  },
  {
    id: 'image',
    kind: 'image',
    tool: 'image-converter',
    route: 'webp-to-jpg',
    title: 'webp_to_jpg_b9d912d',
    scenario: 'the_right_format_ready_to_use_ef7a9bb',
    description: 'this_illustration_has_a_transparent_backgr_81d4da9',
    settings: 'jpg_quality_85_white_background_b55ee02',
    options: { format: 'jpg', quality: 85, background: '#ffffff', firstFrame: false },
    input: {
      url: '/examples/studio-transparent.webp',
      name: 'studio-transparent.webp',
      mime: 'image/webp',
      size: sizes.image.inputBytes,
    },
    output: {
      url: '/examples/studio-white.jpg',
      name: 'studio-white.jpg',
      mime: 'image/jpeg',
      size: sizes.image.outputBytes,
    },
  },
  {
    id: 'pdf',
    kind: 'pdf',
    tool: 'pdf-compressor',
    route: 'pdf-compressor',
    title: 'pdf_compression_19de9a4',
    scenario: 'a_document_with_room_to_spare_e27eb71',
    description: 'an_original_one_page_document_with_an_illu_f9f2dd1',
    settings: 'strong_compression_one_page_pdf_with_an_im_cf1ddb1',
    options: { preset: 'strong' },
    input: {
      url: '/examples/studio-original.pdf',
      name: 'studio-original.pdf',
      mime: 'application/pdf',
      size: sizes.pdf.inputBytes,
      preview: '/examples/pdf-original.webp',
    },
    output: {
      url: '/examples/studio-compressed.pdf',
      name: 'studio-compressed.pdf',
      mime: 'application/pdf',
      size: sizes.pdf.outputBytes,
      preview: '/examples/pdf-compressed.webp',
    },
  },
];
export function publicExample(id: string | undefined) {
  return publicExamples.find((example) => example.id === id);
}
