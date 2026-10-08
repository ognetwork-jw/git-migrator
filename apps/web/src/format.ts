export interface DateTimeOptions {
  /** A BCP 47 tag. Default: the viewer's language (the runtime's default locale). */
  readonly locale?: string;
  /** An IANA zone. Default: the viewer's time zone. */
  readonly timeZone?: string;
  readonly style?: 'short' | 'medium';
}

/**
 * Formats a date for display in the viewer's locale and time zone, through `Intl` (UI-001). Takes
 * ISO strings as the API sends them; a value that is not a date renders as an empty string rather
 * than throwing, so one bad row cannot break a table.
 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  options: DateTimeOptions = {},
): string {
  if (value === null || value === undefined) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: options.style ?? 'medium',
    timeStyle: 'short',
    timeZone: options.timeZone,
  }).format(date);
}
