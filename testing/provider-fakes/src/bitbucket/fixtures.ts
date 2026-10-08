import type { BitbucketState } from './state.ts';

/** Builds a world into freshly reset state. T-043 registers `world` here. */
export type FixtureBuilder = (state: BitbucketState) => void;

export type FixtureRegistry = Record<string, FixtureBuilder>;

/** The built-in fixtures. `empty` is the reset state: the configured credentials, nothing else. */
export const BUILTIN_FIXTURES: FixtureRegistry = {
  empty: () => {},
};
