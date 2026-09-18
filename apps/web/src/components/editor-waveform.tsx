'use client';
import type { TimeRange } from '@filemorph/core/editing';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import Regions from 'wavesurfer.js/dist/plugins/regions.esm.js';
import Timeline from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import { Button } from './ui/button';

export default function EditorWaveform({
  url,
  peaksUrl,
  range,
  onChange,
}: {
  url: string;
  peaksUrl: string;
  range?: TimeRange;
  onChange: (r: TimeRange) => void;
}) {
  const copy = useTranslations('media');

  const container = useRef<HTMLDivElement>(null),
    audio = useRef<HTMLAudioElement>(null);
  const plugin = useRef<Regions | null>(null),
    ws = useRef<WaveSurfer | null>(null),
    current = useRef({ range, onChange }),
    selection = useRef(false);
  const [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [zoom, setZoom] = useState(0);
  current.current = { range, onChange };
  useEffect(() => {
    const controller = new AbortController();
    let instance: WaveSurfer | undefined;
    setReady(false);
    setError('');
    void (async () => {
      try {
        const response = await fetch(peaksUrl, { signal: controller.signal });
        if (!response.ok) throw new Error('Waveform failed');
        const data = await response.json();
        if (controller.signal.aborted || !container.current || !audio.current) return;
        const regions = Regions.create();
        plugin.current = regions;
        instance = WaveSurfer.create({
          container: container.current,
          media: audio.current,
          url,
          peaks: data.peaks,
          duration: data.duration,
          height: 120,
          waveColor: '#b4a6d2',
          progressColor: '#7862a8',
          cursorColor: '#34264e',
          normalize: true,
          plugins: [regions, Timeline.create()],
        });
        ws.current = instance;
        instance.on('ready', () => {
          if (controller.signal.aborted) return;
          // Regions clamp to the loaded duration; creating them before ready yields a zero-length marker.
          const r = current.current.range;
          if (r)
            regions.addRegion({
              id: 'selection',
              start: r.startMs / 1000,
              end: r.endMs / 1000,
              color: 'rgba(127,98,175,.18)',
              minLength: 0.001,
            });
          setReady(true);
        });
        regions.on('region-updated', (region) =>
          current.current.onChange({
            startMs: Math.round(region.start * 1000),
            endMs: Math.round(region.end * 1000),
          }),
        );
        instance.on('error', () => {
          if (!controller.signal.aborted)
            setError(copy('could_not_load_audio_refresh_to_retry_248ba89'));
        });
      } catch (e) {
        if (!controller.signal.aborted)
          setError(copy('could_not_load_waveform_refresh_to_retry_c2787f4'));
      }
    })();
    return () => {
      controller.abort();
      instance?.destroy();
      ws.current = null;
      plugin.current = null;
    };
  }, [url, peaksUrl]);
  useEffect(() => {
    const region = plugin.current?.getRegions()[0];
    if (region && range)
      region.setOptions({ start: range.startMs / 1000, end: range.endMs / 1000 });
    else if (range && ready)
      plugin.current?.addRegion({
        id: 'selection',
        start: range.startMs / 1000,
        end: range.endMs / 1000,
        color: 'rgba(127,98,175,.18)',
        minLength: 0.001,
      });
    else if (!range && region) region.remove();
  }, [range?.startMs, range?.endMs, ready]);
  return (
    <div className="editor-waveform">
      <div ref={container} data-testid="waveform" />
      {!ready && !error && <p role="status">{copy('loading_waveform_0233b43')}</p>}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <audio
        ref={audio}
        controls
        preload="metadata"
        onTimeUpdate={() => {
          if (
            selection.current &&
            audio.current &&
            current.current.range &&
            audio.current.currentTime >= current.current.range.endMs / 1000
          ) {
            audio.current.pause();
            selection.current = false;
          }
        }}
      />
      <div className="action-row">
        <Button
          variant="outline"
          size="sm"
          disabled={!ready || !range}
          onClick={() => {
            if (audio.current && range) {
              selection.current = true;
              audio.current.currentTime = range.startMs / 1000;
              void audio.current.play().catch(() => setError(copy('unable_to_play_audio_6a58e03')));
            }
          }}
        >
          {copy('play_selection_558223f')}
        </Button>
        <label className="editor-zoom">
          {copy('zoom_9b3cbed')}
          <input
            aria-label={copy('waveform_zoom_fc52977')}
            type="range"
            min="0"
            max="200"
            value={zoom}
            onChange={(e) => {
              setZoom(+e.target.value);
              ws.current?.zoom(+e.target.value);
            }}
          />
        </label>
      </div>
    </div>
  );
}
