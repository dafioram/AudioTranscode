#!/usr/bin/env node
/**
 * Downloads the pinned ffmpeg.wasm assets into ./vendor so the site can serve
 * them from its own origin.
 *
 *   npm run vendor
 *
 * This is not optional polish — see the note in js/converter.js and the
 * README's Troubleshooting section. The ffmpeg.wasm maintainers are explicit
 * that @ffmpeg/ffmpeg cannot be loaded from a CDN via a <script> tag, because
 * it spawns its own worker and that worker's cross-origin loading is
 * unreliable: https://github.com/ffmpegwasm/ffmpeg.wasm/discussions/798
 * Vendoring puts every file on the same origin as the page, which sidesteps
 * the problem entirely rather than working around it.
 *
 * @ffmpeg/util is deliberately not fetched here. Its published UMD bundle
 * throws on load in a real browser — a genuine bug in that package. The one
 * function this app needed from it is reimplemented directly in
 * js/converter.js instead, so there's nothing to vendor for it.
 *
 * Fetches through the npm registry rather than a CDN: registry.npmjs.org is
 * reachable from effectively everywhere (including CI runners with locked-down
 * egress), and a package tarball is a stable, content-addressed artifact
 * rather than a CDN path that can change shape between versions.
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { FFMPEG_VERSION, CORE_VERSION } from '../js/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'vendor');
const REGISTRY = 'https://registry.npmjs.org';

const PACKAGES = [
  { name: '@ffmpeg/ffmpeg', version: FFMPEG_VERSION },
  { name: '@ffmpeg/core', version: CORE_VERSION },
];

// Which files land in vendor/, and where they come from inside each tarball.
// No @ffmpeg/util here — see the note in js/converter.js for why.
const FILES = [
  { pkg: '@ffmpeg/ffmpeg', src: 'dist/umd/ffmpeg.js', dest: 'ffmpeg.js' },
  { pkg: '@ffmpeg/ffmpeg', src: 'dist/umd/814.ffmpeg.js', dest: '814.ffmpeg.js' },
  { pkg: '@ffmpeg/core', src: 'dist/umd/ffmpeg-core.js', dest: 'ffmpeg-core.js' },
  { pkg: '@ffmpeg/core', src: 'dist/umd/ffmpeg-core.wasm', dest: 'ffmpeg-core.wasm' },
];

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function tarballUrl(name, version) {
  // The registry's package metadata gives the exact tarball URL rather than
  // us guessing the path convention, which has changed for some packages.
  const metaUrl = `${REGISTRY}/${name}/${version}`;
  const res = await fetch(metaUrl);
  if (!res.ok) throw new Error(`${metaUrl} returned ${res.status}`);
  const meta = await res.json();
  return meta.dist.tarball;
}

async function downloadTarball(url, destDir) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tgzPath = join(destDir, 'package.tgz');
  await writeFile(tgzPath, bytes);
  execFileSync('tar', ['xzf', tgzPath, '-C', destDir]);
}

async function main() {
  const work = join(tmpdir(), `ffmpeg-vendor-${Date.now()}`);
  await mkdir(work, { recursive: true });
  await mkdir(OUT, { recursive: true });

  try {
    for (const { name, version } of PACKAGES) {
      const pkgDir = join(work, name.replace('/', '__'));
      await mkdir(pkgDir, { recursive: true });
      process.stdout.write(`  fetching ${name}@${version} … `);
      const url = await tarballUrl(name, version);
      await downloadTarball(url, pkgDir);
      console.log('ok');
    }

    for (const file of FILES) {
      const pkgDir = join(work, file.pkg.replace('/', '__'));
      const src = join(pkgDir, 'package', file.src);
      const dest = join(OUT, file.dest);
      const bytes = await readFile(src);
      await writeFile(dest, bytes);
      console.log(`  wrote vendor/${file.dest}  (${mb(bytes.length)})`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log('\nDone. vendor/ now holds every file the encoder needs.');
  console.log('js/config.js already points at vendor/ by default.');
}

main().catch((error) => {
  console.error('\nVendoring failed:', error.message);
  process.exit(1);
});
