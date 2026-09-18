'use client';
import type { PreparationView, TimeRange } from '@filemorph/core/editing';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { timecode } from './editor-video-transport';

export default function VideoTimeline({
  source,
  ranges,
  selected,
  currentTime,
  onSelect,
  onChange,
  onSeek,
}: {
  source: PreparationView;
  ranges: TimeRange[];
  selected: number;
  currentTime: number;
  onSelect: (i: number) => void;
  onChange: (r: TimeRange) => void;
  onSeek: (s: number) => void;
}) {
  const copy = useTranslations('media');

  const track = useRef<HTMLDivElement>(null);
  const duration = Math.round(source.media!.duration * 1000),
    active = ranges[selected];
  const percent = (ms: number) =>
    `${Number.isFinite(ms) ? Math.max(0, Math.min(100, (ms / duration) * 100)) : 0}%`;
  const fromPointer = (x: number) => {
    const box = track.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (x - box.left) / box.width)) * duration);
  };
  const change = (edge: 'startMs' | 'endMs', value: number) => {
    if (!active) return;
    const ms =
      edge === 'startMs'
        ? Math.max(0, Math.min(active.endMs - 1, value))
        : Math.min(duration, Math.max(active.startMs + 1, value));
    onChange({ ...active, [edge]: ms });
    onSeek(ms / 1000);
  };
  return (
    <div className="editor-timeline">
      <div
        className="timeline-track"
        ref={track}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target !== e.currentTarget) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(fromPointer(e.clientX) / 1000);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) onSeek(fromPointer(e.clientX) / 1000);
        }}
      >
        <div
          className="timeline-thumbnails"
          aria-hidden="true"
          style={{
            backgroundImage: source.thumbnailsUrl ? `url("${source.thumbnailsUrl}")` : undefined,
          }}
        />
        {ranges.map((r, i) => (
          <button
            key={i}
            type="button"
            aria-label={`${copy('region_0f21717')} ${i + 1}`}
            aria-pressed={i === selected}
            className={`timeline-region ${i === selected ? 'selected' : ''}`}
            style={{ left: percent(r.startMs), width: percent(r.endMs - r.startMs) }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              onSelect(i);
              onSeek(fromPointer(e.clientX) / 1000);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                onSeek(fromPointer(e.clientX) / 1000);
            }}
            onClick={(e) => {
              if (e.detail === 0) {
                onSelect(i);
                onSeek(r.startMs / 1000);
              }
            }}
          >
            <span>{ranges.length > 1 ? i + 1 : ''}</span>
          </button>
        ))}
        <div
          className="timeline-playhead"
          aria-hidden="true"
          style={{ left: percent(currentTime * 1000) }}
        />
        {active &&
          Number.isFinite(active.startMs) &&
          Number.isFinite(active.endMs) &&
          (['startMs', 'endMs'] as const).map((edge) => (
            <button
              key={edge}
              type="button"
              className={`timeline-handle ${edge === 'startMs' ? 'start' : 'end'}`}
              style={{ left: percent(active[edge]) }}
              role="slider"
              aria-label={
                edge === 'startMs'
                  ? copy('selection_start_handle_0a9f016')
                  : copy('selection_end_handle_8e14ca9')
              }
              aria-valuemin={edge === 'startMs' ? 0 : active.startMs + 1}
              aria-valuemax={edge === 'startMs' ? active.endMs - 1 : duration}
              aria-valuenow={active[edge]}
              aria-valuetext={timecode(active[edge], true)}
              aria-orientation="horizontal"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.stopPropagation();
                  change(edge, fromPointer(e.clientX));
                }
              }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 100 : 1;
                const delta = ['ArrowRight', 'ArrowUp'].includes(e.key)
                  ? step
                  : ['ArrowLeft', 'ArrowDown'].includes(e.key)
                    ? -step
                    : 0;
                if (delta || e.key === 'Home' || e.key === 'End') {
                  e.preventDefault();
                  change(
                    edge,
                    e.key === 'Home' ? 0 : e.key === 'End' ? duration : active[edge] + delta,
                  );
                }
              }}
            >
              <span />
            </button>
          ))}
      </div>
      <div className="timeline-ruler">
        <span>{timecode(active?.startMs ?? 0, true)}</span>
        <span>{timecode(active?.endMs ?? duration, true)}</span>
      </div>
      <input
        className="sr-only"
        aria-label={copy('timeline_playback_position_cc9fd46')}
        type="range"
        min="0"
        max={duration}
        step="1"
        value={Math.min(duration, Math.round(currentTime * 1000))}
        onChange={(e) => onSeek(+e.target.value / 1000)}
      />
    </div>
  );
}
