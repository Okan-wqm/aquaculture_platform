import { useState, useCallback, useEffect } from 'react';
import { useAuth } from './useAuth';

// SEC-06: CSRF defense-in-depth header
const CSRF_HEADER = { 'X-Requested-With': 'XMLHttpRequest' };

// ============================================================================
// WebAuthn Browser Support Check
// ============================================================================

/**
 * Check if the browser supports WebAuthn (Public Key Credentials API).
 * Returns false on browsers without biometric/security key support.
 */
export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials !== 'undefined'
  );
}

/**
 * Check if platform authenticator is available (Touch ID, Face ID, Windows Hello).
 * Returns false on devices without built-in biometric hardware.
 */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// ============================================================================
// GraphQL Operations
// ============================================================================

const REGISTRATION_CHALLENGE_MUTATION = `
  mutation WebAuthnRegistrationChallenge($input: WebAuthnRegistrationChallengeInput) {
    webAuthnRegistrationChallenge(input: $input) {
      challenge
      rpId
      rpName
      userId
      userName
    }
  }
`;

const REGISTER_CREDENTIAL_MUTATION = `
  mutation RegisterWebAuthnCredential($input: WebAuthnRegisterCredentialInput!) {
    registerWebAuthnCredential(input: $input) {
      success
      message
      credentialId
    }
  }
`;

const LOGIN_CHALLENGE_MUTATION = `
  mutation WebAuthnLoginChallenge($input: WebAuthnLoginChallengeInput!) {
    webAuthnLoginChallenge(input: $input) {
      challenge
      rpId
      allowedCredentialIds
    }
  }
`;

const VERIFY_LOGIN_MUTATION = `
  mutation VerifyWebAuthnLogin($input: WebAuthnVerifyLoginInput!) {
    verifyWebAuthnLogin(input: $input) {
      accessToken
      refreshToken
      user {
        id
        email
        firstName
        lastName
        role
        tenantId
      }
    }
  }
`;

const MY_CREDENTIALS_QUERY = `
  query MyWebAuthnCredentials {
    myWebAuthnCredentials {
      credentialId
      deviceName
      createdAt
      lastUsedAt
    }
  }
`;

const HAS_CREDENTIALS_QUERY = `
  query HasWebAuthnCredentials {
    hasWebAuthnCredentials
  }
`;

const REMOVE_CREDENTIAL_MUTATION = `
  mutation RemoveWebAuthnCredential($credentialId: String!) {
    removeWebAuthnCredential(credentialId: $credentialId) {
      success
      message
    }
  }
`;

// ============================================================================
// Helper: Base64URL encoding/decoding
// ============================================================================

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlToBuffer(base64url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + padding;
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

// ============================================================================
// Types
// ============================================================================

export interface WebAuthnCredentialInfo {
  credentialId: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string;
}

// ============================================================================
// Hook: useWebAuthn
// ============================================================================

export function useWebAuthn() {
  const { accessToken, isAuthenticated } = useAuth();
  const [isSupported, setIsSupported] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [credentials, setCredentials] = useState<WebAuthnCredentialInfo[]>([]);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check browser support on mount
  useEffect(() => {
    isPlatformAuthenticatorAvailable().then(setIsSupported);
  }, []);

  // Fetch user's credentials when authenticated
  useEffect(() => {
    if (isAuthenticated && accessToken && isSupported) {
      fetchCredentials();
      checkHasCredentials();
    }
  }, [isAuthenticated, accessToken, isSupported]);

  /**
   * Helper: Make authenticated GraphQL request
   */
  const graphqlRequest = useCallback(
    async (query: string, variables?: Record<string, unknown>) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...CSRF_HEADER,
      };
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }

      const response = await fetch('/graphql', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ query, variables }),
      });

      const result = await response.json();
      if (result.errors) {
        throw new Error(result.errors[0]?.message || 'GraphQL request failed');
      }
      return result.data;
    },
    [accessToken],
  );

  /**
   * Fetch the current user's WebAuthn credentials list.
   */
  const fetchCredentials = useCallback(async () => {
    try {
      const data = await graphqlRequest(MY_CREDENTIALS_QUERY);
      setCredentials(data.myWebAuthnCredentials || []);
    } catch {
      // Silently fail — not critical
    }
  }, [graphqlRequest]);

  /**
   * Check if the current user has any WebAuthn credentials.
   */
  const checkHasCredentials = useCallback(async () => {
    try {
      const data = await graphqlRequest(HAS_CREDENTIALS_QUERY);
      setHasCredentials(data.hasWebAuthnCredentials ?? false);
    } catch {
      setHasCredentials(false);
    }
  }, [graphqlRequest]);

  /**
   * Register a new biometric credential.
   *
   * Flow:
   * 1. Request challenge from backend
   * 2. Call navigator.credentials.create() with challenge
   * 3. Send credential back to backend for storage
   */
  const registerCredential = useCallback(
    async (deviceName?: string): Promise<boolean> => {
      if (!isSupported) {
        setError('Biometric authentication not supported on this device');
        return false;
      }

      setIsRegistering(true);
      setError(null);

      try {
        // Step 1: Get registration challenge
        const challengeData = await graphqlRequest(REGISTRATION_CHALLENGE_MUTATION, {
          input: deviceName ? { deviceName } : undefined,
        });
        const challengeResponse = challengeData.webAuthnRegistrationChallenge;

        // Step 2: Call WebAuthn API
        const credential = (await navigator.credentials.create({
          publicKey: {
            challenge: base64urlToBuffer(challengeResponse.challenge),
            rp: {
              id: challengeResponse.rpId,
              name: challengeResponse.rpName,
            },
            user: {
              id: new TextEncoder().encode(challengeResponse.userId),
              name: challengeResponse.userName,
              displayName: challengeResponse.userName,
            },
            pubKeyCredParams: [
              { alg: -7, type: 'public-key' },   // ES256 (ECDSA P-256)
              { alg: -257, type: 'public-key' },  // RS256 (RSASSA-PKCS1-v1_5)
            ],
            authenticatorSelection: {
              authenticatorAttachment: 'platform', // Only platform authenticators (Touch ID, Face ID)
              userVerification: 'required',
              residentKey: 'preferred',
            },
            timeout: 60000, // 60 seconds
            attestation: 'none', // We don't need attestation for biometric login
          },
        })) as PublicKeyCredential | null;

        if (!credential) {
          setError('Biometric registration was cancelled');
          return false;
        }

        const attestationResponse = credential.response as AuthenticatorAttestationResponse;

        // Extract public key in SPKI format
        const publicKey = attestationResponse.getPublicKey?.();
        if (!publicKey) {
          setError('Failed to extract public key from credential');
          return false;
        }

        // Get transports if available
        const transports = attestationResponse.getTransports?.() || [];

        // Step 3: Send to backend
        const registerData = await graphqlRequest(REGISTER_CREDENTIAL_MUTATION, {
          input: {
            credentialId: bufferToBase64url(credential.rawId),
            publicKey: bufferToBase64url(publicKey),
            clientDataJSON: bufferToBase64url(attestationResponse.clientDataJSON),
            challenge: challengeResponse.challenge,
            origin: window.location.origin,
            deviceName: deviceName || 'Biometric Device',
            transports,
          },
        });

        if (registerData.registerWebAuthnCredential.success) {
          // Save credential ID locally for quick lookup
          saveCredentialIdLocally(registerData.registerWebAuthnCredential.credentialId);
          // Refresh credentials list
          await fetchCredentials();
          await checkHasCredentials();
          return true;
        } else {
          setError(registerData.registerWebAuthnCredential.message || 'Registration failed');
          return false;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Biometric registration failed';
        // Don't show error for user cancellation
        if (message.includes('AbortError') || message.includes('cancelled') || message.includes('NotAllowedError')) {
          setError('Biometric registration was cancelled');
        } else {
          setError(message);
        }
        return false;
      } finally {
        setIsRegistering(false);
      }
    },
    [isSupported, graphqlRequest, fetchCredentials, checkHasCredentials],
  );

  /**
   * Login using biometric authentication.
   *
   * Flow:
   * 1. Request challenge from backend (with email)
   * 2. Call navigator.credentials.get() with challenge
   * 3. Send assertion to backend for verification -> JWT tokens
   *
   * Returns auth data on success, or null on failure.
   */
  const biometricLogin = useCallback(
    async (
      email: string,
    ): Promise<{
      accessToken: string;
      user: { id: string; email: string; firstName?: string; lastName?: string; role: string; tenantId: string | null };
    } | null> => {
      if (!isSupported) {
        setError('Biometric authentication not supported on this device');
        return null;
      }

      setIsLoggingIn(true);
      setError(null);

      try {
        // Step 1: Get login challenge
        const challengeData = await graphqlRequest(LOGIN_CHALLENGE_MUTATION, {
          input: { email },
        });
        const challengeResponse = challengeData.webAuthnLoginChallenge;

        // Step 2: Call WebAuthn API
        const allowCredentials = challengeResponse.allowedCredentialIds.map(
          (id: string) => ({
            id: base64urlToBuffer(id),
            type: 'public-key' as const,
            transports: ['internal' as AuthenticatorTransport],
          }),
        );

        const assertion = (await navigator.credentials.get({
          publicKey: {
            challenge: base64urlToBuffer(challengeResponse.challenge),
            rpId: challengeResponse.rpId,
            allowCredentials,
            userVerification: 'required',
            timeout: 60000,
          },
        })) as PublicKeyCredential | null;

        if (!assertion) {
          setError('Biometric verification was cancelled');
          return null;
        }

        const assertionResponse = assertion.response as AuthenticatorAssertionResponse;

        // Step 3: Send assertion to backend
        const verifyData = await graphqlRequest(VERIFY_LOGIN_MUTATION, {
          input: {
            credentialId: bufferToBase64url(assertion.rawId),
            authenticatorData: bufferToBase64url(assertionResponse.authenticatorData),
            clientDataJSON: bufferToBase64url(assertionResponse.clientDataJSON),
            signature: bufferToBase64url(assertionResponse.signature),
            challenge: challengeResponse.challenge,
            origin: window.location.origin,
          },
        });

        return verifyData.verifyWebAuthnLogin;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Biometric login failed';
        if (message.includes('AbortError') || message.includes('cancelled') || message.includes('NotAllowedError')) {
          setError('Biometric login was cancelled');
        } else {
          setError(message);
        }
        return null;
      } finally {
        setIsLoggingIn(false);
      }
    },
    [isSupported, graphqlRequest],
  );

  /**
   * Remove a credential.
   */
  const removeCredential = useCallback(
    async (credentialId: string): Promise<boolean> => {
      try {
        const data = await graphqlRequest(REMOVE_CREDENTIAL_MUTATION, { credentialId });
        if (data.removeWebAuthnCredential.success) {
          removeCredentialIdLocally(credentialId);
          await fetchCredentials();
          await checkHasCredentials();
          return true;
        }
        return false;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to remove credential');
        return false;
      }
    },
    [graphqlRequest, fetchCredentials, checkHasCredentials],
  );

  return {
    // State
    isSupported,
    isRegistering,
    isLoggingIn,
    credentials,
    hasCredentials,
    error,
    clearError: () => setError(null),

    // Actions
    registerCredential,
    biometricLogin,
    removeCredential,
    refreshCredentials: fetchCredentials,
  };
}

// ============================================================================
// Local Storage Helpers
// ============================================================================
// Store credential IDs locally for quick "has biometric" check without network.
// Credential IDs are NOT secret — they are public identifiers.

const CREDENTIAL_IDS_KEY = 'webauthn_credential_ids';

function saveCredentialIdLocally(credentialId: string): void {
  try {
    const stored = localStorage.getItem(CREDENTIAL_IDS_KEY);
    const ids: string[] = stored ? JSON.parse(stored) : [];
    if (!ids.includes(credentialId)) {
      ids.push(credentialId);
      localStorage.setItem(CREDENTIAL_IDS_KEY, JSON.stringify(ids));
    }
  } catch {
    // localStorage not available — not critical
  }
}

function removeCredentialIdLocally(credentialId: string): void {
  try {
    const stored = localStorage.getItem(CREDENTIAL_IDS_KEY);
    if (stored) {
      const ids: string[] = JSON.parse(stored);
      const filtered = ids.filter((id) => id !== credentialId);
      localStorage.setItem(CREDENTIAL_IDS_KEY, JSON.stringify(filtered));
    }
  } catch {
    // localStorage not available — not critical
  }
}

/**
 * Check if there are locally stored credential IDs.
 * This enables showing the biometric login button without a network request.
 */
export function hasLocalCredentials(): boolean {
  try {
    const stored = localStorage.getItem(CREDENTIAL_IDS_KEY);
    if (!stored) return false;
    const ids: string[] = JSON.parse(stored);
    return ids.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get locally stored email for biometric login.
 */
export function getStoredBiometricEmail(): string | null {
  try {
    return localStorage.getItem('webauthn_email');
  } catch {
    return null;
  }
}

/**
 * Store email for biometric login.
 */
export function storeBiometricEmail(email: string): void {
  try {
    localStorage.setItem('webauthn_email', email);
  } catch {
    // not critical
  }
}

/**
 * Clear stored biometric data.
 */
export function clearBiometricData(): void {
  try {
    localStorage.removeItem(CREDENTIAL_IDS_KEY);
    localStorage.removeItem('webauthn_email');
  } catch {
    // not critical
  }
}
