const UNITS = [
  ['tib', 1024 ** 4],
  ['gib', 1024 ** 3],
  ['mib', 1024 ** 2],
  ['kib', 1024],
] as const;

export type SizeUnit = 'bytes' | (typeof UNITS)[number][0];

/** Splits a byte count into a unit key and a short number (`1.5` GiB), for the message catalog. */
export function splitBytes(bytes: number): { unit: SizeUnit; value: string } {
  for (const [unit, size] of UNITS) {
    if (bytes >= size) return { unit, value: (bytes / size).toFixed(bytes / size >= 10 ? 0 : 1) };
  }
  return { unit: 'bytes', value: String(Math.max(0, Math.round(bytes))) };
}

/** Splits seconds into the largest whole unit (`about 3 h`). */
export function splitDuration(seconds: number): {
  unit: 'seconds' | 'minutes' | 'hours' | 'days';
  count: number;
} {
  if (seconds >= 86_400) return { unit: 'days', count: Math.round(seconds / 86_400) };
  if (seconds >= 3_600) return { unit: 'hours', count: Math.round(seconds / 3_600) };
  if (seconds >= 60) return { unit: 'minutes', count: Math.round(seconds / 60) };
  return { unit: 'seconds', count: Math.max(1, Math.round(seconds)) };
}
