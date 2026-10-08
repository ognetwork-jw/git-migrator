/** Units accepted by DEP-040 duration values such as `7d`, `24h` or `15m`. */
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const DURATION = /^(\d+)([smhd])$/;

/** True when the text is a duration of whole seconds, minutes, hours or days (`7d`, `24h`, `90s`). */
export function isDuration(text: string): boolean {
  return DURATION.test(text);
}

/** Converts `7d`, `24h`, `15m` or `30s` to milliseconds. Returns `undefined` for anything else. */
export function parseDuration(text: string): number | undefined {
  const match = DURATION.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_MS;
  const ms = amount * UNIT_MS[unit];
  return Number.isSafeInteger(ms) ? ms : undefined;
}
