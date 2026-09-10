/**
 * ZIP writer tests. The important ones shell out to the real `unzip` binary,
 * so a passing run means a standard archiver accepts the output, not just that
 * our own reader agrees with our own writer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildZip, crc32, safeEntryName, uniqueName } from '../js/zipwriter.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Info-ZIP UnZip 6.00 (2009) — still what Debian/Ubuntu ships — has a real
 * bug: when LANG is exactly "C.UTF-8", it ignores the UTF-8 general-purpose
 * flag on a zip entry and decodes the name as CP866 instead. GitHub Actions'
 * hosted runners set LANG=C.UTF-8 by default, which is what turned
 * "Låt № 3 — 東京.opus" into "L├еt тДЦ 3 тАФ цЭ▒ф║м.opus" in CI while every
 * local run passed. Every *other* locale value tested — C, POSIX, unset,
 * en_US.UTF-8 — decodes correctly; it's specifically the string "C.UTF-8"
 * that trips it. Pin the environment for the subprocess here rather than
 * depend on whatever the calling shell happens to have set, so this can't
 * come back working-on-my-machine.
 */
const UNZIP_ENV = { ...process.env, LANG: 'C', LC_ALL: 'C' };

function hasUnzip() {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const UNZIP = hasUnzip();

function roundTrip(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const path = join(dir, 'out.zip');
  writeFileSync(path, buildZip(entries));
  execFileSync('unzip', ['-qq', 'out.zip', '-d', 'extracted'], { cwd: dir, env: UNZIP_ENV });
  const outDir = join(dir, 'extracted');
  const files = readdirSync(outDir);
  const read = (name) => new Uint8Array(readFileSync(join(outDir, name)));
  return { dir, files, read, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('crc32 matches the known check value', () => {
  // The CRC-32 of "123456789" is the standard check constant.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('unzip accepts the archive and the bytes survive', { skip: !UNZIP && 'unzip not installed' }, () => {
  const a = new Uint8Array(readFileSync(join(FIXTURES, 'opus.opus')));
  const b = new Uint8Array(readFileSync(join(FIXTURES, 'mp3_320_art.mp3')));
  const { files, read, cleanup } = roundTrip([
    { name: 'Slow Tide.opus', bytes: a },
    { name: 'Slow Tide.mp3', bytes: b },
  ]);

  try {
    assert.deepEqual(files.sort(), ['Slow Tide.mp3', 'Slow Tide.opus']);
    assert.deepEqual(read('Slow Tide.opus'), a);
    assert.deepEqual(read('Slow Tide.mp3'), b);
  } finally {
    cleanup();
  }
});

test('unzip reports no CRC errors', { skip: !UNZIP && 'unzip not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  try {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'flac_art.flac')));
    writeFileSync(join(dir, 'out.zip'), buildZip([{ name: 'a.flac', bytes }]));
    const report = execFileSync('unzip', ['-t', 'out.zip'], { cwd: dir, encoding: 'utf8', env: UNZIP_ENV });
    assert.match(report, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-ASCII filenames round-trip through the UTF-8 flag', { skip: !UNZIP && 'unzip not installed' }, () => {
  const bytes = new TextEncoder().encode('hello');
  const { files, read, cleanup } = roundTrip([{ name: 'Låt № 3 — 東京.opus', bytes }]);
  try {
    assert.equal(files.length, 1);
    assert.equal(files[0], 'Låt № 3 — 東京.opus');
    assert.deepEqual(read(files[0]), bytes);
  } finally {
    cleanup();
  }
});

test('an empty archive is well formed rather than corrupt', { skip: !UNZIP && 'unzip not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  let output = '';
  try {
    writeFileSync(join(dir, 'out.zip'), buildZip([]));
    output = execFileSync('unzip', ['-t', 'out.zip'], { cwd: dir, encoding: 'utf8', env: UNZIP_ENV });
  } catch (error) {
    // unzip exits 1 on an empty archive, so read both streams off the error.
    output = `${error.stdout || ''}${error.stderr || ''}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // "empty" is fine, a structural complaint is not.
  assert.match(output, /zipfile is empty|No errors detected/i);
  assert.doesNotMatch(output, /cannot find|overlapped|bad zipfile|not a zipfile/i);
});

test('many small files keep their contents distinct', { skip: !UNZIP && 'unzip not installed' }, () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({
    name: `track-${String(i).padStart(2, '0')}.bin`,
    bytes: new TextEncoder().encode(`payload number ${i}`),
  }));
  const { files, read, cleanup } = roundTrip(entries);
  try {
    assert.equal(files.length, 60);
    assert.equal(new TextDecoder().decode(read('track-42.bin')), 'payload number 42');
  } finally {
    cleanup();
  }
});

test('path separators cannot escape the extract directory', () => {
  assert.equal(safeEntryName('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeEntryName('/absolute/path.mp3'), 'absolute-path.mp3');
  assert.equal(safeEntryName('C:\\Windows\\evil.mp3'), 'C-Windows-evil.mp3');
});

test('reserved characters and edge names are cleaned', () => {
  assert.equal(safeEntryName('AC/DC - Song?.mp3'), 'AC-DC - Song-.mp3');
  assert.equal(safeEntryName('   '), 'track');
  assert.equal(safeEntryName(''), 'track');
  assert.equal(safeEntryName('trailing.  '), 'trailing');
  assert.ok(safeEntryName('x'.repeat(400) + '.opus').length <= 180);
  assert.ok(safeEntryName('x'.repeat(400) + '.opus').endsWith('.opus'));
});

test('duplicate names are numbered instead of overwritten', () => {
  const taken = new Set();
  assert.equal(uniqueName('song.opus', taken), 'song.opus');
  assert.equal(uniqueName('song.opus', taken), 'song-2.opus');
  assert.equal(uniqueName('song.opus', taken), 'song-3.opus');
  assert.equal(uniqueName('other.opus', taken), 'other.opus');
});

test('duplicates survive a real extraction as separate files', { skip: !UNZIP && 'unzip not installed' }, () => {
  const { files, cleanup } = roundTrip([
    { name: 'Untitled.opus', bytes: new TextEncoder().encode('one') },
    { name: 'Untitled.opus', bytes: new TextEncoder().encode('two') },
  ]);
  try {
    assert.equal(files.length, 2, 'the second file must not clobber the first');
  } finally {
    cleanup();
  }
});
