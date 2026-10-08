/**
 * Field bounds for the five-field cron expressions used by DEP-040 schedules
 * (minute, hour, day of month, month, day of week). Day of week accepts 0-7, where 7 is Sunday.
 */
const FIELDS: readonly { readonly name: string; readonly min: number; readonly max: number }[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

const NUMBER = /^\d+$/;

/** Checks one comma-separated element: `*`, `n`, `a-b`, optionally with `/step`. */
function validElement(element: string, min: number, max: number): boolean {
  const [range = '', step, extra] = element.split('/');
  if (extra !== undefined) return false;
  if (step !== undefined && (!NUMBER.test(step) || Number(step) < 1 || Number(step) > max))
    return false;
  if (range === '*') return true;
  const [from = '', to, more] = range.split('-');
  if (more !== undefined || !NUMBER.test(from)) return false;
  const start = Number(from);
  if (start < min || start > max) return false;
  if (to === undefined) return true;
  if (!NUMBER.test(to)) return false;
  const end = Number(to);
  return end >= start && end <= max;
}

/**
 * True when `text` is a five-field cron expression whose every field is inside its range.
 * Names (`MON`, `JAN`) and the `?`, `L`, `W` and `#` extensions are not accepted.
 */
export function isCron(text: string): boolean {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== FIELDS.length || text !== text.trim()) return false;
  return FIELDS.every((field, index) => {
    const value = fields[index] ?? '';
    return value.split(',').every((element) => validElement(element, field.min, field.max));
  });
}
