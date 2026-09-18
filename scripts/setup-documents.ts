import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const existing = resolve(
  '.data/venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const bootstrap = process.env.PYTHON_BOOTSTRAP || (existsSync(existing) ? existing : 'python3.12');
function run(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(bootstrap, ['-m', 'venv', '.data/docling-venv']);
const python = resolve(
  '.data/docling-venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
run(python, ['-m', 'pip', 'install', '-r', 'apps/worker/python/docling-requirements.lock']);
run(python, ['scripts/setup-documents.py']);
