'use client';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type CSSProperties, type RefObject } from 'react';

export function timecode(ms: number, precise = false) {
  const n = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const hours = Math.floor(n / 3600000);
  const minutes = Math.floor(n / 60000) % 60;
  const seconds = Math.floor(n / 1000) % 60;
  return `${precise || hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${precise ? `.${String(n % 1000).padStart(3, '0')}` : ''}`;
}
export default function EditorVideoTransport({
  videoRef,
  url,
  duration,
  compact = false,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  url: string;
  duration: number;
  compact?: boolean;
}) {
  const copy = useTranslations('media');

  const [state, setState] = useState({ playing: false, time: 0, muted: false, volume: 1 });
  const [error, setError] = useState(false);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setError(false);
    const sync = () =>
      setState({
        playing: !v.paused && !v.ended,
        time: v.currentTime,
        muted: v.muted,
        volume: v.volume,
      });
    const events = [
      'timeupdate',
      'play',
      'pause',
      'ended',
      'volumechange',
      'loadedmetadata',
      'emptied',
    ];
    events.forEach((event) => v.addEventListener(event, sync));
    sync();
    return () => events.forEach((event) => v.removeEventListener(event, sync));
  }, [url, videoRef]);
  const mute = (
    <button
      type="button"
      className="transport-icon transport-mute"
      aria-label={state.muted || !state.volume ? copy('unmute_7044c31') : copy('mute_0f09734')}
      onClick={() => {
        const v = videoRef.current;
        if (v) {
          const inaudible = v.muted || !v.volume;
          if (!v.volume) v.volume = 1;
          v.muted = !inaudible;
          setState((s) => ({ ...s, muted: v.muted, volume: v.volume }));
        }
      }}
    >
      {state.muted || !state.volume ? <VolumeX size={20} /> : <Volume2 size={20} />}
    </button>
  );
  return (
    <>
      <div
        className={`video-transport ${compact ? 'compact' : ''}`}
        role="group"
        aria-label={copy('video_playback_controls_0253148')}
      >
        {compact && mute}
        <button
          type="button"
          className="transport-icon transport-play"
          aria-label={copy(state.playing ? 'pause' : 'play')}
          onClick={async () => {
            const v = videoRef.current;
            if (!v) return;
            if (!v.paused) v.pause();
            else {
              try {
                await v.play();
                setError(false);
              } catch {
                setError(true);
              }
            }
          }}
        >
          {state.playing ? (
            <Pause size={compact ? 27 : 22} fill="currentColor" />
          ) : (
            <Play size={compact ? 27 : 22} fill={compact ? 'currentColor' : 'none'} />
          )}
        </button>
        <span className="transport-time">
          {timecode(state.time * 1000)}
          {compact && <span className="transport-total"> / {timecode(duration * 1000)}</span>}
        </span>
        {!compact && (
          <>
            <input
              className="transport-seek"
              aria-label={copy('preview_position_7c29c64')}
              type="range"
              min="0"
              max={duration}
              step="0.001"
              value={Math.min(duration, state.time)}
              style={
                {
                  '--range-fill': `${Math.min(100, (state.time / duration) * 100)}%`,
                } as CSSProperties
              }
              onChange={(e) => {
                const time = +e.target.value;
                setState((s) => ({ ...s, time }));
                if (videoRef.current) videoRef.current.currentTime = time;
              }}
            />
            <span className="transport-time transport-total">{timecode(duration * 1000)}</span>
            {mute}
            <input
              className="transport-volume"
              aria-label={copy('volume_3b18e8e')}
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={state.muted ? 0 : state.volume}
              style={
                { '--range-fill': `${state.muted ? 0 : state.volume * 100}%` } as CSSProperties
              }
              onChange={(e) => {
                const v = videoRef.current,
                  volume = +e.target.value;
                setState((s) => ({ ...s, volume, muted: false }));
                if (v) {
                  v.volume = volume;
                  v.muted = false;
                }
              }}
            />
          </>
        )}
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {copy('playback_could_not_start_please_try_again_70f84b1')}
        </p>
      )}
    </>
  );
}
