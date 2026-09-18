import {
  AudioLines,
  Crop,
  Eraser,
  FileText,
  Image,
  Languages,
  Repeat2,
  Scissors,
  TextSelect,
  Video,
} from 'lucide-react';
const icons = {
  eraser: Eraser,
  video: Video,
  image: Image,
  file: FileText,
  audio: AudioLines,
  scissors: Scissors,
  crop: Crop,
  convert: Repeat2,
  text: TextSelect,
  languages: Languages,
};
export function ToolIcon({ name, size = 24 }: { name: string; size?: number }) {
  const Icon = icons[name as keyof typeof icons] || FileText;
  return <Icon size={size} strokeWidth={1.7} />;
}
