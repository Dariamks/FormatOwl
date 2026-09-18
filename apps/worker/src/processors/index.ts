import { isConversionTool } from '@filemorph/core/conversion';
import { convertFile } from './converter';
import type { EditorMedia, EditResultInfo } from '@filemorph/core/editing';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { writeFile, stat } from 'node:fs/promises';
import { probe, encode, runProcess, MediaError } from '@filemorph/core/media';
import {
  mimeForName,
  type Tool,
  type ToolOptions,
  type CompressionOptions,
  type AudioOptions,
  type FileInfo,
  type ResultNote,
} from '@filemorph/core/domain';
import { probeAudio, encodeAudio } from './audio';
export const pythonBinary =
  process.env.PYTHON_PATH ||
  fileURLToPath(
    new URL(
      process.platform === 'win32'
        ? '../../../../.data/venv/Scripts/python.exe'
        : '../../../../.data/venv/bin/python',
      import.meta.url,
    ),
  );
export interface Processed {
  media: FileInfo;
  note: ResultNote;
  output: string;
  name: string;
  mime: string;
  inputPreview?: string;
  outputPreview?: string;
  inputMedia?: { id: string; media: EditorMedia }[];
  outputMedia?: EditResultInfo;
  previewMime?: string;
}
export async function processFile(
  tool: Tool,
  options: ToolOptions,
  name: string,
  input: string,
  temp: string,
  signal: AbortSignal,
  progress: (p: number) => void,
): Promise<Processed> {
  if (isConversionTool(tool))
    return convertFile(
      tool,
      options as import('@filemorph/core/conversion').ConversionOptions,
      name,
      input,
      temp,
      signal,
      progress,
    );
  if (
    !['video-compressor', 'audio-compressor', 'image-compressor', 'pdf-compressor'].includes(tool)
  )
    throw new MediaError('UNSUPPORTED_TOOL', 'No processor registered');
  const extension =
    tool === 'video-compressor'
      ? 'mp4'
      : tool === 'audio-compressor'
        ? (options as AudioOptions).format
        : name.split('.').pop()!.toLowerCase();
  const output = join(temp, `output.${extension}`);
  const outputName = `${name.replace(/\.[^.]*$/, '')}-formatowl.${extension}`;
  const base = { output, name: outputName, mime: mimeForName(outputName) };
  if (tool === 'video-compressor') {
    const media = await probe(input, signal);
    await encode(input, output, options as CompressionOptions, media, temp, signal, progress);
    await probe(output, signal);
    return { ...base, media, note: null };
  }
  if (tool === 'audio-compressor') {
    const media = await probeAudio(input, signal);
    const verified = await encodeAudio(
      input,
      output,
      options as AudioOptions,
      media,
      signal,
      progress,
    );
    const note = (await stat(output)).size >= (await stat(input)).size ? 'LARGER' : null;
    // Raw AAC, FLAC and Ogg vary across browsers; serve a separate listening copy.
    let inputPreview: string | undefined;
    if (!['mp3', 'm4a', 'wav'].includes(name.split('.').pop()!.toLowerCase())) {
      inputPreview = join(temp, 'original.m4a');
      await encodeAudio(
        input,
        inputPreview,
        { preset: 'light', format: 'm4a', bitrate: 192, sampleRate: 'auto', channels: 'auto' },
        media,
        signal,
        () => {},
      );
    }
    return {
      ...base,
      media: {
        ...media,
        outputSampleRate: verified.sampleRate,
        outputChannels: verified.channels,
        outputBitrate: verified.bitrate,
      },
      note,
      inputPreview,
      previewMime: 'audio/mp4',
    };
  }
  const params = join(temp, 'parameters.json');
  await writeFile(
    params,
    JSON.stringify({
      source: input,
      output,
      preset: 'preset' in options ? options.preset : 'balanced',
      tool,
      extension,
    }),
  );
  let result: Partial<Processed> & { error?: string } = {};
  let buffer = '';
  const onData = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.progress) progress(data.progress);
        else result = data;
      } catch {}
    }
  };
  try {
    if (tool === 'pdf-compressor' || extension === 'heic')
      await runProcess(
        pythonBinary,
        [fileURLToPath(new URL('../../python/process_file.py', import.meta.url)), params],
        signal,
        onData,
        600000,
      );
    else
      await runProcess(
        process.execPath,
        [fileURLToPath(new URL('./image.mjs', import.meta.url)), params],
        signal,
        onData,
        300000,
      );
  } catch (e) {
    if (signal.aborted) throw e;
    if (result.error) throw new MediaError(result.error, result.error);
    throw e;
  }
  if (!result.media) throw new MediaError('INVALID_OUTPUT', 'Processor did not produce a result');
  return {
    ...base,
    media: result.media,
    note: result.note || null,
    inputPreview: result.inputPreview,
    outputPreview: result.outputPreview,
    previewMime: 'image/jpeg',
  };
}
