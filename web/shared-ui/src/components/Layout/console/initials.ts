/**
 * The user plate's initials (README §7.4): the first letters of the first two
 * words of the name, uppercase — "Deniz Yılmaz" → "DY". A blank name falls
 * back to the e-mail's first letter, so the plate is never empty. Uppercasing
 * follows the UI locale: under Turkish "ilker" → "İ", not "I".
 */
export function initialsOf(name: string, email: string, locale?: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const letters = words.slice(0, 2).map((word) => word.charAt(0));
  const initials = letters.length > 0 ? letters.join('') : email.charAt(0);
  return initials.toLocaleUpperCase(locale);
}
