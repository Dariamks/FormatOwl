import type { ReadingResult } from './reading';
export function mindmapLayout(nodes: ReadingResult['nodes'], collapsed: string[] = []) {
  const children = (id: string) =>
    collapsed.includes(id) ? [] : nodes.filter((n) => n.parentId === id);
  const lines = (text: string) => {
    const out: string[] = [];
    let line = '',
      width = 0;
    for (const ch of text) {
      const size = /[^\x00-\xff]/.test(ch) ? 2 : 1;
      if (width + size > 26) {
        out.push(line);
        line = '';
        width = 0;
      }
      line += ch;
      width += size;
    }
    if (line) out.push(line);
    return out;
  };
  type Node = ReadingResult['nodes'][number] & {
    x: number;
    y: number;
    width: number;
    height: number;
    lines: string[];
  };
  const placed: Node[] = [];
  const height = (n: ReadingResult['nodes'][number]): number =>
    Math.max(
      lines(n.label).length * 22 + 28,
      children(n.id).reduce((s, c) => s + height(c) + 18, 0) - 18,
    );
  const place = (n: ReadingResult['nodes'][number], depth: number, top: number) => {
    const h = height(n),
      text = lines(n.label),
      own = text.length * 22 + 28;
    placed.push({
      ...n,
      x: 24 + depth * 280,
      y: top + (h - own) / 2,
      width: 236,
      height: own,
      lines: text,
    });
    let cursor = top;
    for (const child of children(n.id)) {
      place(child, depth + 1, cursor);
      cursor += height(child) + 18;
    }
  };
  const root = nodes.find((n) => n.parentId === null);
  if (root) place(root, 0, 24);
  return {
    nodes: placed,
    width: Math.max(500, ...placed.map((n) => n.x + n.width + 24)),
    height: Math.max(250, ...placed.map((n) => n.y + n.height + 24)),
  };
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
export function mindmapSvg(result: ReadingResult) {
  const map = mindmapLayout(result.nodes);
  const edges = map.nodes
    .filter((n) => n.parentId)
    .map((n) => {
      const p = map.nodes.find((p) => p.id === n.parentId)!;
      return `<path d="M${p.x + p.width},${p.y + p.height / 2} C${p.x + p.width + 22},${p.y + p.height / 2} ${n.x - 22},${n.y + n.height / 2} ${n.x},${n.y + n.height / 2}" fill="none" stroke="#a3b295" stroke-width="2"/>`;
    })
    .join('');
  const nodes = map.nodes
    .map(
      (n) =>
        `<g><rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="12" fill="${n.parentId ? '#ffffff' : '#edf3e7'}" stroke="#bdcbb2"/><text font-family="Noto Sans CJK SC,PingFang SC,sans-serif" font-size="16" fill="#293526">${n.lines.map((s, i) => `<tspan x="${n.x + 14}" y="${n.y + 28 + i * 22}">${escape(s)}</tspan>`).join('')}</text></g>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${map.width}" height="${map.height}" viewBox="0 0 ${map.width} ${map.height}"><title>${escape(result.title)}</title><rect width="100%" height="100%" fill="#f8faf6"/>${edges}${nodes}</svg>`;
}
