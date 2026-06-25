/** Single-quote a string for /bin/sh (safe for newlines and embedded double-quotes). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
