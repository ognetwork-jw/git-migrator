// Values vitest.config.ts provides to every test file (`inject(...)`). A declaration file, so both
// the tests' program (through vitest.config.ts) and the tools program see it.
import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Multiplier for wall-clock budgets and timeouts: GM_TEST_TIME_FACTOR (ADR-0507). */
    timeFactor: number;
  }
}
