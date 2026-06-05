#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const next = argv[index + 1];
    args[key.slice(2)] = next?.startsWith('--') ? true : next ?? true;
  }
  return args;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(command, args, {
      cwd: rootDir,
      stdio: 'inherit',
      ...options
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} salio con codigo ${code}.`));
    });
  });
}

const args = readArgs(process.argv.slice(2));

if (platform() !== 'darwin') {
  throw new Error('Este builder genera ejecutables macOS Mach-O. Ejecutalo en macOS.');
}

const outDir = resolve(rootDir, args['out-dir'] || 'release');
const buildDir = resolve(rootDir, '.sea-build');
const bundlePath = resolve(buildDir, 'resolve-sources.bundle.cjs');
const blobPath = resolve(buildDir, 'resolve-sources.blob');
const seaConfigPath = resolve(buildDir, 'sea-config.json');
const executableName = args.name || `resolve-sources-macos-${arch()}`;
const executablePath = resolve(outDir, executableName);
const nodePath = args.node ? resolve(rootDir, args.node) : process.execPath;

await rm(buildDir, { force: true, recursive: true });
await mkdir(buildDir, { recursive: true });
await mkdir(outDir, { recursive: true });

await esbuild.build({
  bundle: true,
  entryPoints: [resolve(rootDir, 'scripts/resolve-sources.mjs')],
  format: 'cjs',
  outfile: bundlePath,
  platform: 'node',
  target: 'node22'
});

await writeFile(seaConfigPath, JSON.stringify({
  disableExperimentalSEAWarning: true,
  main: bundlePath,
  output: blobPath,
  useCodeCache: true
}, null, 2));

await run(nodePath, ['--experimental-sea-config', seaConfigPath]);
await copyFile(nodePath, executablePath);
await run('codesign', ['--remove-signature', executablePath]);
await run(resolve(rootDir, 'node_modules/.bin/postject'), [
  executablePath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  seaFuse,
  '--macho-segment-name',
  'NODE_SEA'
]);
await run('codesign', ['--sign', '-', executablePath]);

process.stdout.write(`\nOK: ${executablePath}\n`);
