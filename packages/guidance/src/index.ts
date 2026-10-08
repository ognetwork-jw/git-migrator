/**
 * @git-migrator/guidance: Manual Task and Blocker guidance for every Finding code (FAC-002, UI-040).
 * Pure data and templating: no I/O, no provider identifiers in code (guidance text may quote the
 * provider UI, GLO-002). See README.md for the i18n integration.
 */
export const PACKAGE_NAME = '@git-migrator/guidance';

export * from './codes.ts';
export * from './coverage.ts';
export * from './entries.ts';
export * from './params.ts';
export * from './render.ts';
export * from './template.ts';
export * from './types.ts';
