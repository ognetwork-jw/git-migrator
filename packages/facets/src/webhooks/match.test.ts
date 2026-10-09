import { describe, expect, it } from 'vitest';
import { matchesPattern, pathGlobMatches } from './match.ts';

describe('[FAC-WEB-002] path glob matcher', () => {
  it('[FAC-WEB-002] * stays inside a segment and ** crosses segments', () => {
    expect(pathGlobMatches('/a/*/c', '/a/b/c')).toBe(true);
    expect(pathGlobMatches('/a/*/c', '/a/b/x/c')).toBe(false);
    expect(pathGlobMatches('/a/**', '/a/b/x/c')).toBe(true);
    expect(pathGlobMatches('/a/**/c', '/a/b/x/c')).toBe(true);
    expect(pathGlobMatches('/a/**/c', '/a/c')).toBe(false);
    expect(pathGlobMatches('/hook-*', '/hook-12')).toBe(true);
    expect(pathGlobMatches('/hook-*', '/hook-1/2')).toBe(false);
    expect(pathGlobMatches('/', '/')).toBe(true);
    expect(pathGlobMatches('/a.b', '/axb')).toBe(false);
  });

  it('[FAC-WEB-002] adjacent stars collapse: *** and ** * behave like **', () => {
    expect(pathGlobMatches('/a/***', '/a/b/c')).toBe(true);
    expect(pathGlobMatches('/a/*/**', '/a/b/c/d')).toBe(true);
    expect(pathGlobMatches('/a/**/**', '/a/b/c')).toBe(true);
  });

  it('[FAC-WEB-002] a pathological pattern and input finish fast (linear, not exponential)', () => {
    const pattern = `/${Array.from({ length: 8 }, () => '**').join('/')}/never`;
    const text = `/${Array.from({ length: 40 }, (_, i) => `seg${i}`).join('/')}`;
    const started = performance.now();
    expect(pathGlobMatches(pattern, text)).toBe(false);
    const manyStars = `/${'a*'.repeat(900)}b`;
    expect(pathGlobMatches(manyStars, `/${'a'.repeat(1500)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('[FAC-WEB-002] a pattern or a path over 2048 characters never matches', () => {
    expect(pathGlobMatches('/**', `/${'a'.repeat(2100)}`)).toBe(false);
    expect(pathGlobMatches(`/${'a'.repeat(2100)}`, '/a')).toBe(false);
    expect(matchesPattern(`https://h.test/${'a'.repeat(2100)}`, 'https://h.test/**')).toBe(false);
    expect(matchesPattern('https://h.test/x', `https://h.test/${'*'.repeat(2100)}`)).toBe(false);
  });

  it('[FAC-WEB-002] ** in a host never matches', () => {
    expect(matchesPattern('https://a.b.test/x', 'https://**.test/x')).toBe(false);
    expect(matchesPattern('https://a.test/x', 'https://*.test/x')).toBe(true);
  });
});
