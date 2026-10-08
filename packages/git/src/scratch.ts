/**
 * Scratch size estimate for the disk precheck (JOB-015). The precheck itself (free space, the
 * 10 minute delay, the counter) belongs to the jobs runtime; it consumes this number.
 */
export function scratchNeededBytes(input: {
  readonly sizeBytes: number | bigint | null | undefined;
  readonly lfsBytes: number | bigint | null | undefined;
}): number {
  const size = Number(input.sizeBytes ?? 0);
  const lfs = Number(input.lfsBytes ?? 0);
  // sizeBytes x 2.2 in integer arithmetic: 100 bytes need exactly 220, not 221.
  return Math.ceil((size * 22) / 10) + lfs;
}
