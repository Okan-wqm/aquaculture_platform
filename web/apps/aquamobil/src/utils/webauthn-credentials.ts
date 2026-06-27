// ============================================================================
// WebAuthn Credential Helpers
// ============================================================================

const PLATFORM_AUTHENTICATOR_TRANSPORTS: AuthenticatorTransport[] = ['internal'];
const CREDENTIAL_IDS_KEY = 'webauthn_credential_ids';
const BIOMETRIC_EMAIL_KEY = 'webauthn_email';

export interface WebAuthnCredentialInfo {
  credentialId: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface WebAuthnRegistrationChallengePayload {
  challenge: string;
  rpId: string;
  rpName: string;
  userId: string;
  userName: string;
}

export interface WebAuthnLoginChallengePayload {
  challenge: string;
  rpId: string;
  allowedCredentialIds: string[];
}

export interface WebAuthnMutationResultPayload {
  success: boolean;
  message?: string | null;
  credentialId?: string | null;
}

export interface WebAuthnLoginUserPayload {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  tenantId: string | null;
}

export interface WebAuthnLoginPayload {
  accessToken: string;
  refreshToken: string;
  user: WebAuthnLoginUserPayload;
}

export interface WebAuthnRegistrationChallengeResponse {
  webAuthnRegistrationChallenge: WebAuthnRegistrationChallengePayload;
}

export interface RegisterWebAuthnCredentialResponse {
  registerWebAuthnCredential: WebAuthnMutationResultPayload;
}

export interface WebAuthnLoginChallengeResponse {
  webAuthnLoginChallenge: WebAuthnLoginChallengePayload;
}

export interface VerifyWebAuthnLoginResponse {
  verifyWebAuthnLogin: WebAuthnLoginPayload;
}

export interface MyWebAuthnCredentialsResponse {
  myWebAuthnCredentials: WebAuthnCredentialInfo[];
}

export interface HasWebAuthnCredentialsResponse {
  hasWebAuthnCredentials: boolean;
}

export interface RemoveWebAuthnCredentialResponse {
  removeWebAuthnCredential: WebAuthnMutationResultPayload;
}

export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials !== 'undefined'
  );
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function base64urlToBuffer(base64url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + padding;
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

export function createInternalCredentialDescriptors(
  credentialIds: readonly string[],
): PublicKeyCredentialDescriptor[] {
  return credentialIds.map((credentialId): PublicKeyCredentialDescriptor => ({
    id: base64urlToBuffer(credentialId),
    type: 'public-key',
    transports: [...PLATFORM_AUTHENTICATOR_TRANSPORTS],
  }));
}

export function saveCredentialIdLocally(credentialId: string): void {
  try {
    const stored = localStorage.getItem(CREDENTIAL_IDS_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    const ids = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];

    if (!ids.includes(credentialId)) {
      ids.push(credentialId);
      localStorage.setItem(CREDENTIAL_IDS_KEY, JSON.stringify(ids));
    }
  } catch {
    // localStorage may be unavailable in hardened browser contexts.
  }
}

export function removeCredentialIdLocally(credentialId: string): void {
  try {
    const stored = localStorage.getItem(CREDENTIAL_IDS_KEY);
    if (!stored) return;

    const parsed: unknown = JSON.parse(stored);
    const ids = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
    const filtered = ids.filter((id) => id !== credentialId);
    localStorage.setItem(CREDENTIAL_IDS_KEY, JSON.stringify(filtered));
  } catch {
    // localStorage may be unavailable in hardened browser contexts.
  }
}

export function hasLocalCredentials(): boolean {
  try {
    const stored = localStorage.getItem(CREDENTIAL_IDS_KEY);
    if (!stored) return false;

    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.some((item) => typeof item === 'string');
  } catch {
    return false;
  }
}

export function getStoredBiometricEmail(): string | null {
  try {
    return localStorage.getItem(BIOMETRIC_EMAIL_KEY);
  } catch {
    return null;
  }
}

export function storeBiometricEmail(email: string): void {
  try {
    localStorage.setItem(BIOMETRIC_EMAIL_KEY, email);
  } catch {
    // localStorage may be unavailable in hardened browser contexts.
  }
}

export function clearBiometricData(): void {
  try {
    localStorage.removeItem(CREDENTIAL_IDS_KEY);
    localStorage.removeItem(BIOMETRIC_EMAIL_KEY);
  } catch {
    // localStorage may be unavailable in hardened browser contexts.
  }
}
