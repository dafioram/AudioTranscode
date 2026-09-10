#!/usr/bin/env node
/**
 * Runs `vendor.mjs` only if vendor/ doesn't already have everything the
 * encoder needs. Wired as `prestart` so `npm start` works without a manual
 * step, but doesn't re-download 30+ MB every single time you start the
 * server.
 */
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VENDOR = join(ROOT, 'vendor');

const REQUIRED = ['ffmpeg.js', '814.ffmpeg.js', 'ffmpeg-core.js', 'ffmpeg-core.wasm'];

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

const missing = [];
for (const file of REQUIRED) {
  if (!(await exists(join(VENDOR, file)))) missing.push(file);
}

if (missing.length === 0) {
  console.log('vendor/ already has everything the encoder needs, skipping.');
  process.exit(0);
}

console.log(`vendor/ is missing ${missing.join(', ')} — fetching now (one-time, ~32 MB)…\n`);
const result = spawnSync(process.execPath, [join(HERE, 'vendor.mjs')], { stdio: 'inherit' });
process.exit(result.status ?? 1);

