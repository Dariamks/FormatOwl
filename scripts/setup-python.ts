import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const bootstrap = process.env.PYTHON_BOOTSTRAP || 'python3.12';
function run(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(bootstrap, ['-m', 'venv', '.data/venv']);
const python = resolve(
  '.data/venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
run(python, ['-m', 'pip', 'install', '-r', 'apps/worker/python/requirements.lock']);
if (
  spawnSync(python, ['-c', "from PIL import features; assert features.check('raqm')"]).status !== 0
) {
  if (process.platform === 'darwin') {
    process.env.AR = '/usr/bin/ar';
    process.env.CC = '/usr/bin/clang';
    process.env.CXX = '/usr/bin/clang++';
    process.env.PKG_CONFIG_PATH = [
      '/opt/homebrew/lib/pkgconfig',
      '/usr/local/lib/pkgconfig',
      process.env.PKG_CONFIG_PATH,
    ]
      .filter(Boolean)
      .join(':');
  }
  console.log(
    'Building Pillow with Raqm. Install libraqm/harfbuzz/fribidi development libraries first.',
  );
  run(python, [
    '-m',
    'pip',
    'install',
    '--no-binary',
    'Pillow',
    '--force-reinstall',
    'Pillow==12.3.0',
    '-C',
    'raqm=enable',
  ]);
}
