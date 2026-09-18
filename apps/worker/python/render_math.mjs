// Local-only MathJax renderer. Load a fixed TeX package set; document text cannot
// load extensions, read files, fetch URLs or execute TeX commands on the host.
import MathJax from '@mathjax/src';
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
await MathJax.init({
  loader: { load: ['input/tex', 'output/svg'] },
  tex: {
    packages: ['base', 'ams'],
    maxBuffer: 20000,
    maxMacros: 1000,
    formatError: (_jax, error) => {
      throw error;
    },
  },
  svg: { fontCache: 'none', linebreaks: { inline: false } },
});
try {
  const result = {};
  for (const tex of request.formulas) {
    if (typeof tex !== 'string' || tex.length > 12000) throw Error('Invalid formula');
    const node = await MathJax.tex2svgPromise(tex, { display: false, em: 16, ex: 8 });
    const adaptor = MathJax.startup.adaptor;
    const svgNode = adaptor.firstChild(node);
    const raw = adaptor.outerHTML(svgNode);
    if (/data-mml-node="merror"/.test(raw)) throw Error('Invalid formula');
    const view = adaptor.getAttribute(svgNode, 'viewBox').split(/\s+/).map(Number);
    const width = view[2] / 1000,
      height = view[3] / 1000;
    if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n < 150))
      throw Error('Formula too large');
    // MathJax puts the original TeX in accessibility attributes. Escape every
    // attribute value before sharp parses the SVG as XML.
    const safeRaw = raw.replace(/(\s[\w:-]+=")([^"]*)(")/g, (_m, open, value, close) =>
      open + value.replace(/&(?!(?:amp|lt|gt|quot|apos);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + close,
    );
    const svg = safeRaw
      .replace(/width="[^"]*"/, `width="${Math.ceil(width * 64)}"`)
      .replace(/height="[^"]*"/, `height="${Math.ceil(height * 64)}"`);
    const name = `math-${createHash('sha256').update(tex).digest('hex').slice(0, 24)}.png`;
    await sharp(Buffer.from(svg)).png().toFile(join(request.folder, name));
    result[tex] = { file: name, width, height, depth: (view[1] + view[3]) / 1000 };
  }
  await writeFile(request.result, JSON.stringify(result));
} finally {
  MathJax.done();
}
