import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRunner } from '../../src/main/util/detect-runner';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mango-detect-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('detectRunner', () => {
  it('detects spring-gradle when gradlew + build.gradle exist', () => {
    writeFileSync(join(dir, 'gradlew'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'build.gradle'), 'plugins {}\n');
    expect(detectRunner(dir)).toEqual({ kind: 'spring-gradle', command: './gradlew bootRun' });
  });

  it('detects spring-gradle with the kotlin build script (build.gradle.kts)', () => {
    writeFileSync(join(dir, 'gradlew'), '');
    writeFileSync(join(dir, 'build.gradle.kts'), '');
    expect(detectRunner(dir).kind).toBe('spring-gradle');
  });

  it('does NOT detect spring-gradle when gradlew is missing', () => {
    writeFileSync(join(dir, 'build.gradle'), '');
    expect(detectRunner(dir).kind).toBe('unknown');
  });

  it('prefers spring-gradle over npm when both are present', () => {
    writeFileSync(join(dir, 'gradlew'), '');
    writeFileSync(join(dir, 'build.gradle'), '');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    expect(detectRunner(dir).kind).toBe('spring-gradle');
  });

  it('detects npm with a dev script (npm run dev)', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    expect(detectRunner(dir)).toEqual({ kind: 'npm', command: 'npm run dev' });
  });

  it('falls back to npm start when there is no dev script', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node .' } }));
    expect(detectRunner(dir)).toEqual({ kind: 'npm', command: 'npm start' });
  });

  it('prefers dev over start when both scripts exist', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite', start: 'node .' } }),
    );
    expect(detectRunner(dir).command).toBe('npm run dev');
  });

  it('returns unknown for a package.json with no runnable script', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    expect(detectRunner(dir)).toEqual({ kind: 'unknown', command: undefined });
  });

  it('returns unknown (no throw) for malformed package.json', () => {
    writeFileSync(join(dir, 'package.json'), '{ not json');
    expect(detectRunner(dir).kind).toBe('unknown');
  });

  it('returns unknown for an empty dir', () => {
    expect(detectRunner(dir)).toEqual({ kind: 'unknown', command: undefined });
  });
});
