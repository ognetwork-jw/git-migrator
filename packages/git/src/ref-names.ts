/**
 * A port of `git check-ref-format` (without `--allow-onelevel`), for names that are about to be
 * used in a refspec. Non-ASCII characters are valid; `+` inside a name is valid.
 */
export function isValidRefName(name: string): boolean {
  if (name === '' || name === '@' || name.startsWith('/') || name.endsWith('/')) return false;
  if (name.endsWith('.') || name.includes('..') || name.includes('@{') || name.includes('//')) {
    return false;
  }
  for (const char of name) {
    const code = char.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f) return false;
    if (' ~^:?*[\\'.includes(char)) return false;
  }
  if (!name.includes('/')) return false;
  return name
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}
