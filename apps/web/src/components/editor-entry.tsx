'use client';
import type { EditorTool } from '@filemorph/core/editing';
import dynamic from 'next/dynamic';
const Editor = dynamic(() => import('./media-editor').then((m) => m.MediaEditor), { ssr: false });
export default function EditorEntry({
  tool,
  showHeading = true,
}: {
  tool: EditorTool;
  showHeading?: boolean;
}) {
  return <Editor tool={tool} showHeading={showHeading} />;
}
