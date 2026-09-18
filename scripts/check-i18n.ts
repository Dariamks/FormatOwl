import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { locales } from '../apps/web/src/i18n/registry';
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const intlRequire = createRequire(webRequire.resolve('next-intl'));
const coreRequire = createRequire(intlRequire.resolve('use-intl'));
const { parse } = await import(coreRequire.resolve('@formatjs/icu-messageformat-parser'));
const root = new URL('../apps/web/messages/', import.meta.url);
const requested =
  process.argv
    .find((v) => v.startsWith('--locales='))
    ?.split('=')[1]
    .split(',') ?? locales;
const names = (await readdir(new URL('en/', root))).filter((f) => f.endsWith('.json')).sort();
function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid message object: ${prefix}`);
  return Object.assign(
    {},
    ...Object.entries(value).map(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k)),
  );
}
function shape(message: string): string {
  const result = new Set<string>();
  function visit(nodes: any[]) {
    for (const node of nodes) {
      if (node.type > 0 && node.type !== 7)
        result.add(`${node.type === 8 ? 'tag' : 'arg'}:${node.value}`);
      if (node.children) visit(node.children);
      if (node.options)
        for (const option of Object.values(node.options) as any[]) visit(option.value);
    }
  }
  visit(parse(message, { requiresOtherClause: true }));
  return [...result].sort().join('|');
}
const failures: string[] = [];
let count = 0;
for (const locale of requested) {
  if (!locales.includes(locale as (typeof locales)[number])) {
    failures.push(`Unknown locale: ${locale}`);
    continue;
  }
  for (const file of names) {
    const source = flatten(JSON.parse(await readFile(new URL(`en/${file}`, root), 'utf8')));
    let target: Record<string, string>;
    try {
      target = flatten(JSON.parse(await readFile(new URL(`${locale}/${file}`, root), 'utf8')));
    } catch {
      failures.push(`${locale}/${file}: missing or invalid dictionary`);
      continue;
    }
    for (const key of new Set([...Object.keys(source), ...Object.keys(target)])) {
      const where = `${locale}/${file}:${key}`;
      if (!(key in source) || !(key in target)) {
        failures.push(`${where}: key mismatch`);
        continue;
      }
      if (!target[key].trim()) failures.push(`${where}: empty message`);
      try {
        if (shape(source[key]) !== shape(target[key]))
          failures.push(`${where}: argument/tag mismatch`);
      } catch (e) {
        failures.push(`${where}: invalid ICU ${String(e)}`);
      }
      if (/987\d{3}/.test(target[key])) failures.push(`${where}: unresolved translation marker`);
      // Technical identifiers must survive translation as well as ICU arguments.
      if (!['en', 'zh', 'zh-Hant'].includes(locale)) {
        const identifiers = new Set(
          source[key].match(/FormatOwl|FFmpeg|DOCX|WebP|HEIC|H\.264|H\.265|PDF|MP4|MP3|PPTX/g) ??
            [],
        );
        for (const identifier of identifiers)
          if (!target[key].includes(identifier))
            failures.push(`${where}: missing technical identifier ${identifier}`);
        for (const marker of target[key].match(/(?:97\d{2,}|98\d{2,})/g) ?? [])
          if (!source[key].includes(marker))
            failures.push(`${where}: unexpected translation marker ${marker}`);
      }
      count++;
    }
  }
}
// Catch literal calls left behind during migrations, including server-only page copy.
const sourceMessages = Object.fromEntries(
  await Promise.all(
    names.map(async (name) => [
      name.slice(0, -5),
      flatten(JSON.parse(await readFile(new URL(`en/${name}`, root), 'utf8'))),
    ]),
  ),
);
async function checkCalls(directory: URL): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = new URL(item.name + (item.isDirectory() ? '/' : ''), directory);
    if (item.isDirectory()) {
      await checkCalls(file);
      continue;
    }
    if (!/\.tsx?$/.test(item.name) || item.name.endsWith('.d.ts')) continue;
    const code = await readFile(file, 'utf8');
    const tree = ts.createSourceFile(
      file.pathname,
      code,
      ts.ScriptTarget.Latest,
      true,
      item.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const translators = new Map<string, Set<string>>();
    function collect(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = ts.isAwaitExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        if (
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          ['useTranslations', 'getSiteTranslations'].includes(init.expression.text)
        ) {
          const ns = init.arguments[0];
          if (ns && ts.isStringLiteral(ns)) {
            const values = translators.get(node.name.text) ?? new Set<string>();
            values.add(ns.text);
            translators.set(node.name.text, values);
          }
        }
      }
      ts.forEachChild(node, collect);
    }
    collect(tree);
    function validate(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const candidates = translators.get(node.expression.text),
          key = node.arguments[0];
        if (
          candidates &&
          key &&
          ts.isStringLiteral(key) &&
          ![...candidates].some((ns) => Object.hasOwn(sourceMessages[ns] ?? {}, key.text))
        )
          failures.push(
            `${file.pathname}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}: unknown message ${key.text}`,
          );
      }
      ts.forEachChild(node, validate);
    }
    validate(tree);
  }
}
await checkCalls(new URL('../apps/web/src/', import.meta.url));
if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`${failures.length} i18n errors`);
  process.exitCode = 1;
} else
  console.log(
    `i18n: ${requested.length} locales, ${names.length} namespaces, ${count} messages validated`,
  );
