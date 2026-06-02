export const PASSWORD_POLICY_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,128}$/;

export const PASSWORD_POLICY_MESSAGE =
  'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character';

export function passwordPolicyViolation(password: string): string | null {
  return PASSWORD_POLICY_REGEX.test(password) ? null : PASSWORD_POLICY_MESSAGE;
}
