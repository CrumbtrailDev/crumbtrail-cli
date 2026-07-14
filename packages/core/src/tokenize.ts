/**
 * Lowercase and split on non-alphanumerics; drop tokens shorter than 3 chars.
 * Shared by intent correlation and fusion ranking. Because input is
 * lowercased first, the character class needs no case-insensitive flag.
 */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}
