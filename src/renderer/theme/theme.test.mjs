/**
 * Theme system unit tests (node:test compatible).
 * Run with: node --test src/renderer/theme/theme.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const themesSrc = readFileSync(new URL('./themes.ts', import.meta.url), 'utf8');

test('default theme is light-blue', () => {
  assert.match(themesSrc, /DEFAULT_THEME:\s*ThemeId\s*=\s*'light-blue'/);
});

test('four themes are defined', () => {
  for (const id of ['light-blue', 'warm-cream', 'silver-light', 'dark']) {
    assert.match(themesSrc, new RegExp(`'${id}'|${id}:`));
  }
});

test('storage keys are stable (brand-agnostic)', () => {
  assert.match(themesSrc, /STORAGE_KEY\s*=\s*'creator-theme'/);
  assert.match(themesSrc, /SYSTEM_SYNC_KEY\s*=\s*'creator-theme-system-sync'/);
});

test('semantic tokens cover required surfaces', () => {
  const required = ['--color-bg', '--color-surface', '--color-text', '--color-primary', '--color-border', '--color-input-bg'];
  for (const t of required) assert.match(themesSrc, new RegExp(t.replace(/[-]/g, '\\-')));
});
