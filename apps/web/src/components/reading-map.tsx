'use client';
import { mindmapLayout } from '@filemorph/core/mindmap';
import type { ReadingResult } from '@filemorph/core/reading';
import { Download, Maximize, Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

export function ReadingMap({
  result,
  onLocate,
  onDownload,
}: {
  result: ReadingResult;
  onLocate: (id: string) => void;
  onDownload: () => void;
}) {
  const copy = useTranslations('reading');

  const [collapsed, setCollapsed] = useState<string[]>([]);
  const map = useMemo(() => mindmapLayout(result.nodes, collapsed), [result.nodes, collapsed]);
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState({ x: 0, y: 0, zoom: 1 });
  const autoFit = useRef(true);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  function fit() {
    if (!size.width || !size.height) return;
    const zoom = Math.min(1.25, (size.width - 48) / map.width, (size.height - 96) / map.height);
    setTransform({
      zoom,
      x: (size.width - map.width * zoom) / 2,
      y: (size.height - map.height * zoom) / 2,
    });
    autoFit.current = true;
  }
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth && el.clientHeight)
        setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (autoFit.current) fit();
  }, [size.width, size.height, map.width, map.height]);
  function zoomBy(factor: number) {
    autoFit.current = false;
    setTransform((old) => {
      const zoom = Math.max(0.05, Math.min(3, old.zoom * factor));
      return {
        zoom,
        x: size.width / 2 - ((size.width / 2 - old.x) * zoom) / old.zoom,
        y: size.height / 2 - ((size.height / 2 - old.y) * zoom) / old.zoom,
      };
    });
  }
  function toggle(id: string) {
    autoFit.current = true;
    setCollapsed((old) => (old.includes(id) ? old.filter((v) => v !== id) : [...old, id]));
  }
  return (
    <div className="reading-map" data-testid="mindmap-canvas">
      <div className="reading-map-tools">
        <button onClick={() => zoomBy(1.2)} aria-label={copy('zoom_in_map_8ead2c9')}>
          <Plus size={16} />
        </button>
        <button onClick={() => zoomBy(1 / 1.2)} aria-label={copy('zoom_out_map_27b080c')}>
          <Minus size={16} />
        </button>
        <span>{Math.round(transform.zoom * 100)}%</span>
        <button onClick={fit} aria-label={copy('fit_map_15aeb8a')} title={copy('fit_map_15aeb8a')}>
          <Maximize size={16} />
        </button>
        <button
          onClick={() => {
            autoFit.current = true;
            setCollapsed([]);
            fit();
          }}
        >
          {copy('expand_all_2af9d49')}
        </button>
        <button
          onClick={() => {
            autoFit.current = true;
            setCollapsed(
              result.nodes
                .filter((n) => n.parentId && result.nodes.some((c) => c.parentId === n.id))
                .map((n) => n.id),
            );
          }}
        >
          {copy('collapse_branches_9660f62')}
        </button>
        <button onClick={onDownload} aria-label={copy('download_map_png_a170c28')}>
          <Download size={16} />
        </button>
      </div>
      <div
        className="reading-map-scroll"
        ref={viewport}
        tabIndex={0}
        aria-label={copy('map_canvas_drag_to_pan_2bec591')}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest('[role="button"]')) return;
          autoFit.current = false;
          drag.current = { x: e.clientX, y: e.clientY, left: transform.x, top: transform.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d)
            setTransform((old) => ({
              ...old,
              x: d.left + e.clientX - d.x,
              y: d.top + e.clientY - d.y,
            }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const delta = {
            ArrowLeft: [40, 0],
            ArrowRight: [-40, 0],
            ArrowUp: [0, 40],
            ArrowDown: [0, -40],
          }[e.key];
          if (delta) {
            e.preventDefault();
            autoFit.current = false;
            setTransform((old) => ({ ...old, x: old.x + delta[0], y: old.y + delta[1] }));
          }
          if (e.key === '+' || e.key === '=') zoomBy(1.2);
          if (e.key === '-') zoomBy(1 / 1.2);
          if (e.key === '0') fit();
        }}
      >
        <svg width="100%" height="100%" role="group" aria-label={result.title}>
          <g
            data-map-transform
            transform={`translate(${transform.x},${transform.y}) scale(${transform.zoom})`}
          >
            {map.nodes
              .filter((n) => n.parentId)
              .map((n) => {
                const p = map.nodes.find((v) => v.id === n.parentId)!;
                return (
                  <path
                    key={n.id}
                    d={`M${p.x + p.width},${p.y + p.height / 2} C${p.x + p.width + 22},${p.y + p.height / 2} ${n.x - 22},${n.y + n.height / 2} ${n.x},${n.y + n.height / 2}`}
                    fill="none"
                    stroke="#b6c5aa"
                    strokeWidth={2}
                  />
                );
              })}
            {map.nodes.map((n) => (
              <g key={n.id} transform={`translate(${n.x},${n.y})`}>
                <g
                  role={n.citations.length ? 'button' : undefined}
                  tabIndex={n.citations.length ? 0 : undefined}
                  aria-label={n.label}
                  onClick={() => n.citations[0] && onLocate(n.citations[0].blockId)}
                  onKeyDown={(e) => {
                    if (['Enter', ' '].includes(e.key) && n.citations[0]) {
                      e.preventDefault();
                      onLocate(n.citations[0].blockId);
                    }
                  }}
                >
                  <rect
                    width={n.width}
                    height={n.height}
                    rx={12}
                    fill={n.parentId ? 'white' : '#edf3e7'}
                    stroke="#b6c5aa"
                  />
                  <text fontSize={16} fill="#293526">
                    {n.lines.map((line, i) => (
                      <tspan key={i} x={14} y={28 + i * 22}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
                {result.nodes.some((c) => c.parentId === n.id) && (
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={`${collapsed.includes(n.id) ? copy('expand_9869e50') : copy('collapse_9cf188d')} ${n.label}`}
                    onClick={() => toggle(n.id)}
                    onKeyDown={(e) => {
                      if (['Enter', ' '].includes(e.key)) {
                        e.preventDefault();
                        toggle(n.id);
                      }
                    }}
                  >
                    <circle cx={n.width} cy={n.height / 2} r={12} fill="#edf3e7" stroke="#b6c5aa" />
                    <text x={n.width} y={n.height / 2 + 5} textAnchor="middle" fontSize={16}>
                      {collapsed.includes(n.id) ? '+' : '−'}
                    </text>
                  </g>
                )}
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
