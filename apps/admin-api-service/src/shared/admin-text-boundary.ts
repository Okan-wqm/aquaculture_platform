/** Unicode control-code policy for operator-visible admin HTTP text. */
export const ADMIN_CONTROL_CHARACTER_FREE_PATTERN = /^[^\p{Cc}]+$/u;

const ADMIN_CONTROL_CHARACTER_PATTERN = /\p{Cc}/gu;

export function replaceAdminControlCharacters(value: string, replacement = ' '): string {
  return value.replace(ADMIN_CONTROL_CHARACTER_PATTERN, replacement);
}
