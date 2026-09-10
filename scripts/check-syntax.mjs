#!/usr/bin/env node
/**
 * Parses every module as strict ESM. Cheaper than a full linter and catches
 * the thing that actually breaks a static site: a syntax error that only
 * surfaces in the browser console.
 *
 *   npm run lint
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['js', 'scripts'];

let failures = 0;

for (const dir of DIRS) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    const path = join(dir, name);
    try {
      parse(readFileSync(join(ROOT, path), 'utf8'), {
        ecmaVersion: 2023,
        sourceType: 'module',
      });
      console.log(`  ok    ${path}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL  ${path}  ${error.message}`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} file${failures === 1 ? '' : 's'} failed to parse.`);
  process.exit(1);
}
console.log('\nAll modules parse as ES modules.');
