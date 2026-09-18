'use client';
import { evenRect, type CropRect, type EditorMedia } from '@filemorph/core/editing';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import EditorVideoTransport from './editor-video-transport';

export default function EditorCrop({
  url,
  media,
  rect,
  ratio,
  onChange,
}: {
  url: string;
  media: EditorMedia;
  rect: CropRect;
  ratio: number | false;
  onChange: (r: CropRect) => void;
}) {
  const copy = useTranslations('media');

  const stage = useRef<HTMLDivElement>(null),
    video = useRef<HTMLVideoElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const scale = width / media.width;
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    if (stage.current) observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const v = video.current,
        c = canvas.current;
      if (v && c && v.readyState >= 2) {
        const w = Math.min(640, rect.width),
          h = Math.max(1, Math.round((w * rect.height) / rect.width));
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        c.getContext('2d')?.drawImage(
          v,
          (rect.x / media.width) * v.videoWidth,
          (rect.y / media.height) * v.videoHeight,
          (rect.width / media.width) * v.videoWidth,
          (rect.height / media.height) * v.videoHeight,
          0,
          0,
          w,
          h,
        );
      }
    };
    const v = video.current;
    const tick = () => {
      draw();
      if (v && !v.paused && !v.ended) frame = requestAnimationFrame(tick);
    };
    const refresh = () => {
      cancelAnimationFrame(frame);
      tick();
    };
    const events = ['loadeddata', 'seeked', 'play', 'pause', 'ended'];
    events.forEach((event) => v?.addEventListener(event, refresh));
    refresh();
    return () => {
      cancelAnimationFrame(frame);
      events.forEach((event) => v?.removeEventListener(event, refresh));
    };
  }, [rect, media]);
  function change(r: CropRect) {
    const normalized = evenRect(r);
    normalized.width = Math.min(media.width, normalized.width);
    normalized.height = Math.min(media.height, normalized.height);
    normalized.x = Math.max(0, Math.min(media.width - normalized.width, normalized.x));
    normalized.y = Math.max(0, Math.min(media.height - normalized.height, normalized.y));
    onChange(normalized);
  }
  return (
    <div>
      <div
        ref={stage}
        className="crop-stage"
        style={{
          aspectRatio: `${media.width}/${media.height}`,
          maxWidth: (media.width / media.height) * 560,
          margin: 'auto',
        }}
      >
        <div className="crop-picture">
          <video ref={video} src={url} preload="auto" playsInline />
          <div
            className="crop-shade"
            aria-hidden="true"
            style={{
              left: `${(rect.x / media.width) * 100}%`,
              top: `${(rect.y / media.height) * 100}%`,
              width: `${(rect.width / media.width) * 100}%`,
              height: `${(rect.height / media.height) * 100}%`,
            }}
          />
        </div>
        {width > 0 && (
          <Rnd
            className="crop-selection"
            bounds="parent"
            size={{ width: rect.width * scale, height: rect.height * scale }}
            position={{ x: rect.x * scale, y: rect.y * scale }}
            minWidth={Math.max(12, 2 * scale)}
            minHeight={Math.max(12, 2 * scale)}
            lockAspectRatio={ratio}
            onDrag={(_, p) =>
              change({ ...rect, x: Math.round(p.x / scale), y: Math.round(p.y / scale) })
            }
            onResize={(_, __, el, ___, p) =>
              change({
                x: Math.round(p.x / scale),
                y: Math.round(p.y / scale),
                width: Math.round(el.offsetWidth / scale),
                height: Math.round(el.offsetHeight / scale),
              })
            }
            resizeHandleComponent={Object.fromEntries(
              [
                'topLeft',
                'topRight',
                'bottomLeft',
                'bottomRight',
                'top',
                'bottom',
                'left',
                'right',
              ].map((key) => [
                key,
                <span className="crop-resize-dot" data-crop-handle={key} key={key} />,
              ]),
            )}
            resizeHandleStyles={Object.fromEntries(
              Object.entries({
                topLeft: { top: -12, left: -12 },
                topRight: { top: -12, right: -12 },
                bottomLeft: { bottom: -12, left: -12 },
                bottomRight: { bottom: -12, right: -12 },
                top: { top: -12, left: 'calc(50% - 12px)' },
                bottom: { bottom: -12, left: 'calc(50% - 12px)' },
                left: { top: 'calc(50% - 12px)', left: -12 },
                right: { top: 'calc(50% - 12px)', right: -12 },
              }).map(([key, position]) => [
                key,
                { width: 24, height: 24, display: 'grid', placeItems: 'center', ...position },
              ]),
            )}
          >
            <span className="crop-grid" aria-hidden="true" />
          </Rnd>
        )}
      </div>
      <EditorVideoTransport videoRef={video} url={url} duration={media.duration} />
      <h3>
        {copy('crop_preview_bddaf45')}{' '}
        <small>
          {rect.width} × {rect.height}
        </small>
      </h3>
      <canvas
        ref={canvas}
        className="crop-output"
        aria-label={copy('cropped_output_preview_9cc033c')}
      />
    </div>
  );
}
