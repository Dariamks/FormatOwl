/** Compare production builds: pnpm exec tsx scripts/measure-i18n.ts http://127.0.0.1:3001 */
import { gzipSync } from 'node:zlib';
const origin = process.argv[2] ?? 'http://127.0.0.1:3001';
const report: Record<string, unknown> = {};
for (const path of ['/en', '/en/tools/video-compressor', '/en/tools/image-translator']) {
  const response = await fetch(origin + path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const html = await response.text();
  const scripts = [
    ...new Set([...html.matchAll(/<script[^>]*src="([^"]+\.js)/g)].map((m) => m[1])),
  ];
  const js = await Promise.all(
    scripts.map(async (path) => {
      const response = await fetch(origin + path.replaceAll('&amp;', '&'));
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      return { path, bytes: data.length, gzip: gzipSync(data).length };
    }),
  );
  const flight = [...html.matchAll(/self\.__next_f\.push\((.*?)\)<\/script>/gs)]
    .flatMap((match) => {
      try {
        const frame = JSON.parse(match[1]);
        return frame[0] === 1 ? [frame[1]] : [];
      } catch {
        return [];
      }
    })
    .join('');
  const payloads = new Map<string, Record<string, unknown>>();
  function visit(node: unknown) {
    if (!node || typeof node !== 'object') return;
    const messages = (node as any).messages;
    if (messages && typeof messages === 'object' && !Array.isArray(messages))
      payloads.set(JSON.stringify(messages), messages);
    for (const value of Object.values(node)) visit(value);
  }
  for (const line of flight.split('\n')) {
    try {
      visit(JSON.parse(line.slice(line.indexOf(':') + 1)));
    } catch {
      /* Non-JSON Flight records. */
    }
  }
  const messages = [...payloads].map(([json, value]) => ({
    namespaces: Object.keys(value),
    bytes: Buffer.byteLength(json),
    gzip: gzipSync(json).length,
  }));
  if (!messages.length)
    throw new Error(`${path}: no message payload found; update the Flight parser`);
  if (
    messages.some((value) =>
      value.namespaces.some((ns) =>
        ['content', 'guide', 'homeServer', 'email', 'tool_information'].includes(ns),
      ),
    )
  )
    throw new Error(`${path}: server content reached the client provider`);
  report[path] = {
    htmlBytes: Buffer.byteLength(html),
    htmlGzip: gzipSync(html).length,
    jsGzip: js.reduce((n, value) => n + value.gzip, 0),
    jsRequests: js.length,
    messages,
    js,
  };
}
console.log(JSON.stringify(report, null, 2));
