/**
 * GM_TEST_TIME_FACTOR (ADR-0507): vitest.config.ts multiplies the default test and hook timeouts by
 * it and provides it to tests as `inject('timeFactor')`, which multiply their wall-clock budgets by
 * it. Set it (for example to 3) on a slow or shared machine. It never tightens a budget.
 */
export function parseTimeFactor(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const factor = Number(raw);
  if (!Number.isFinite(factor) || factor < 1) {
    throw new Error(
      `GM_TEST_TIME_FACTOR must be a number of at least 1, got ${JSON.stringify(raw)}`,
    );
  }
  return factor;
}
