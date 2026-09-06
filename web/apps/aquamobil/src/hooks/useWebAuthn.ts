import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { print } from 'graphql';
import { gql } from 'graphql-tag';
import { useState, useCallback, useEffect } from 'react';

import { useAuth } from './useAuth';

import type {
  HasWebAuthnCredentialsQuery,
  HasWebAuthnCredentialsQueryVariables,
  MyWebAuthnCredentialsQuery,
  MyWebAuthnCredentialsQueryVariables,
  RegisterWebAuthnCredentialMutation,
  RegisterWebAuthnCredentialMutationVariables,
  RemoveWebAuthnCredentialMutation,
  RemoveWebAuthnCredentialMutationVariables,
  VerifyWebAuthnLoginMutation,
  VerifyWebAuthnLoginMutationVariables,
  WebAuthnLoginChallengeMutation,
  WebAuthnLoginChallengeMutationVariables,
  WebAuthnRegistrationChallengeMutation,
  WebAuthnRegistrationChallengeMutationVariables,
} from '@/generated/graphql';
import { readGraphQLResponse, firstGraphQLError } from '@/utils/graphql-response';

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

const REGISTRATION_CHALLENGE_MUTATION: TypedDocumentNode<WebAuthnRegistrationChallengeMutation, WebAuthnRegistrationChallengeMutationVariables> = gql`
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

const REGISTER_CREDENTIAL_MUTATION: TypedDocumentNode<RegisterWebAuthnCredentialMutation, RegisterWebAuthnCredentialMutationVariables> = gql`
  mutation RegisterWebAuthnCredential($input: WebAuthnRegisterCredentialInput!) {
    registerWebAuthnCredential(input: $input) {
      success
      message
      credentialId
    }
  }
`;

const LOGIN_CHALLENGE_MUTATION: TypedDocumentNode<WebAuthnLoginChallengeMutation, WebAuthnLoginChallengeMutationVariables> = gql`
  mutation WebAuthnLoginChallenge($input: WebAuthnLoginChallengeInput!) {
    webAuthnLoginChallenge(input: $input) {
      challenge
      rpId
      allowedCredentialIds
    }
  }
`;

const VERIFY_LOGIN_MUTATION: TypedDocumentNode<VerifyWebAuthnLoginMutation, VerifyWebAuthnLoginMutationVariables> = gql`
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

const MY_CREDENTIALS_QUERY: TypedDocumentNode<MyWebAuthnCredentialsQuery, MyWebAuthnCredentialsQueryVariables> = gql`
  query MyWebAuthnCredentials {
    myWebAuthnCredentials {
      credentialId
      deviceName
      createdAt
      lastUsedAt
    }
  }
`;

const HAS_CREDENTIALS_QUERY: TypedDocumentNode<HasWebAuthnCredentialsQuery, HasWebAuthnCredentialsQueryVariables> = gql`
  query HasWebAuthnCredentials {
    hasWebAuthnCredentials
  }
`;

const REMOVE_CREDENTIAL_MUTATION: TypedDocumentNode<RemoveWebAuthnCredentialMutation, RemoveWebAuthnCredentialMutationVariables> = gql`
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
    binary += String.fromCharCode(bytes[i]);
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

/** Result of a successful biometric login — the generated verifyWebAuthnLogin payload (MOB-HIGH-022). */
export type BiometricLoginResult = VerifyWebAuthnLoginMutation['verifyWebAuthnLogin'];

/** Authenticated user payload returned by the verifyWebAuthnLogin mutation. */
export type BiometricLoginUser = BiometricLoginResult['user'];

// ============================================================================
// Error Sanitization
// ============================================================================

/**
 * Map raw WebAuthn / DOMException errors to user-friendly strings.
 * Known error names are mapped explicitly; anything else falls back to a
 * generic message so internal implementation details are never leaked to the UI.
 *
 * @param err - The caught error (unknown type — could be Error, string, etc.)
 * @returns A safe, user-facing error message string.
 */
export function sanitizeWebAuthnError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : '';

  if (name === 'NotAllowedError' || message.includes('NotAllowedError')) {
    return 'Biometric authentication was denied or timed out. Please try again.';
  }
  if (name === 'AbortError' || message.includes('AbortError') || message.includes('cancelled')) {
    return 'Biometric operation was cancelled.';
  }
  if (name === 'NotSupportedError' || message.includes('NotSupportedError')) {
    return 'This authenticator type is not supported on your device.';
  }
  if (name === 'SecurityError' || message.includes('SecurityError')) {
    return 'A security error occurred. Ensure you are on a secure (HTTPS) connection.';
  }
  if (name === 'InvalidStateError' || message.includes('InvalidStateError')) {
    return 'A credential already exists for this account on this device.';
  }
  if (name === 'ConstraintError' || message.includes('ConstraintError')) {
    return 'The authenticator does not meet the required constraints.';
  }
  // Generic fallback — never expose raw error messages to the user
  return 'Biometric authentication failed. Please try again or use your password.';
}

// ============================================================================
// Hook: useWebAuthn
// ============================================================================

/** Return shape of {@link useWebAuthn}. */
export interface UseWebAuthnReturn {
  /** True when a platform authenticator (Touch ID / Face ID / Hello) is available. */
  isSupported: boolean;
  /** True while a credential registration is in flight. */
  isRegistering: boolean;
  /** True while a biometric login is in flight. */
  isLoggingIn: boolean;
  /** The current user's registered credentials. */
  credentials: WebAuthnCredentialInfo[];
  /** Whether the current user has any registered credentials. */
  hasCredentials: boolean;
  /** Sanitized, user-facing error string, or null. */
  error: string | null;
  /** Clear the current error. */
  clearError: () => void;
  /** Register a new biometric credential; resolves true on success. */
  registerCredential: (deviceName: string | undefined, currentPassword: string) => Promise<boolean>;
  /** Authenticate with biometrics; resolves the auth payload or null. */
  biometricLogin: (email: string) => Promise<BiometricLoginResult | null>;
  /** Remove a credential by id; resolves true on success. */
  removeCredential: (credentialId: string) => Promise<boolean>;
  /** Re-fetch the credentials list. */
  refreshCredentials: () => Promise<void>;
}

export function useWebAuthn(): UseWebAuthnReturn {
  const { accessToken, isAuthenticated } = useAuth();
  const [isSupported, setIsSupported] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [credentials, setCredentials] = useState<WebAuthnCredentialInfo[]>([]);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check browser support on mount
  useEffect(() => {
    // WHY void: fire-and-forget capability probe; the Promise result is delivered
    // via setIsSupported, so the Promise itself is explicitly discarded.
    void isPlatformAuthenticatorAvailable().then(setIsSupported);
  }, []);

  // Fetch user's credentials when authenticated.
  // WHY fetchCredentials/checkHasCredentials are NOT in the deps array: they are
  // declared later in this hook (TDZ — referencing them in the array literal at
  // this point would be a use-before-declaration error), and they are only read
  // inside the effect callback which runs after all consts initialize. The effect
  // is keyed on the auth/support transitions that should actually re-trigger it.
  useEffect(() => {
    if (isAuthenticated && accessToken && isSupported) {
      // WHY void: both fetches update state internally and never throw (each has
      // its own try/catch), so they run as discarded background tasks here.
      void fetchCredentials();
      void checkHasCredentials();
    }
  }, [isAuthenticated, accessToken, isSupported]);

  /**
   * Helper: Make authenticated GraphQL request.
   *
   * WHY a LOCAL request helper (not the shared services/authenticated-fetch
   * graphqlRequest): the WebAuthn flow runs DURING login, before the shared auth
   * store / readiness barrier is populated, so it must use its own fetch with the
   * in-scope accessToken to avoid a circular dependency.
   *
   * S1-CODEGEN / MOB-HIGH-022: `document` is a codegen TypedDocumentNode, so the
   * result AND variable types flow from the document exactly as they do for the
   * shared helper; it is `print()`ed to the wire string.
   */
  const graphqlRequest = useCallback(
    async <TData, TVars>(
      document: TypedDocumentNode<TData, TVars>,
      variables?: TVars,
    ): Promise<TData> => {
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
        body: JSON.stringify({ query: print(document), variables }),
      });

      // SSoT: route the response through readGraphQLResponse so the payload is a
      // typed GraphQLResponse<TData>, never `any` — this is what makes every
      // downstream field access below type-safe (no no-unsafe-* violations).
      const result = await readGraphQLResponse<TData>(response);
      if (result.errors && result.errors.length > 0) {
        throw new Error(firstGraphQLError(result, 'GraphQL request failed'));
      }
      if (!result.data) {
        throw new Error('GraphQL request returned no data');
      }
      return result.data;
    },
    [accessToken],
  );

  /**
   * Fetch the current user's WebAuthn credentials list.
   */
  const fetchCredentials = useCallback(async (): Promise<void> => {
    try {
      const data = await graphqlRequest(MY_CREDENTIALS_QUERY);
      setCredentials(data.myWebAuthnCredentials ?? []);
    } catch {
      // Silently fail — not critical
    }
  }, [graphqlRequest]);

  /**
   * Check if the current user has any WebAuthn credentials.
   */
  const checkHasCredentials = useCallback(async (): Promise<void> => {
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
   * 3. Send the attestation to the backend, which derives the public key
   *    from the attestation object server-side (proof-of-possession) —
   *    the client never asserts its own key material.
   *
   * SEC-CRITICAL-001/002: registration requires password re-authentication
   * (`currentPassword`) so a stolen access token alone cannot plant a
   * biometric credential.
   */
  const registerCredential = useCallback(
    async (deviceName: string | undefined, currentPassword: string): Promise<boolean> => {
      if (!isSupported) {
        setError('Biometric authentication not supported on this device');
        return false;
      }
      if (!currentPassword) {
        setError('Enter your password to confirm biometric setup');
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
              { alg: -7, type: 'public-key' }, // ES256 (ECDSA P-256)
              { alg: -257, type: 'public-key' }, // RS256 (RSASSA-PKCS1-v1_5)
            ],
            authenticatorSelection: {
              authenticatorAttachment: 'platform', // Only platform authenticators (Touch ID, Face ID)
              userVerification: 'required',
              residentKey: 'preferred',
            },
            timeout: 60000, // 60 seconds
            attestation: 'none',
          },
        })) as PublicKeyCredential | null;

        if (!credential) {
          setError('Biometric registration was cancelled');
          return false;
        }

        const attestationResponse = credential.response as AuthenticatorAttestationResponse;

        // COSE algorithm the authenticator chose (server-side key derivation input)
        const publicKeyAlgorithm = attestationResponse.getPublicKeyAlgorithm?.();
        if (typeof publicKeyAlgorithm !== 'number') {
          setError('Authenticator did not report a supported key algorithm');
          return false;
        }

        // Get transports if available
        const transports = attestationResponse.getTransports?.() || [];

        // Step 3: Send the attestation to the backend
        const registerData = await graphqlRequest(REGISTER_CREDENTIAL_MUTATION, {
          input: {
            credentialId: bufferToBase64url(credential.rawId),
            attestationObject: bufferToBase64url(attestationResponse.attestationObject),
            clientDataJSON: bufferToBase64url(attestationResponse.clientDataJSON),
            publicKeyAlgorithm,
            challenge: challengeResponse.challenge,
            currentPassword,
            deviceName: deviceName || 'Biometric Device',
            transports,
          },
        });

        const { success, credentialId, message } = registerData.registerWebAuthnCredential;
        // WHY both checks: the schema types credentialId as nullable; a success
        // without an id is a contract violation, reported instead of stored.
        if (success && credentialId) {
          // Save credential ID locally for quick lookup
          saveCredentialIdLocally(credentialId);
          // Refresh credentials list
          await fetchCredentials();
          await checkHasCredentials();
          return true;
        } else {
          setError(message || 'Registration failed');
          return false;
        }
      } catch (err) {
        setError(sanitizeWebAuthnError(err));
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
    async (email: string): Promise<BiometricLoginResult | null> => {
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
        const allowCredentials: PublicKeyCredentialDescriptor[] =
          challengeResponse.allowedCredentialIds.map((id: string) => ({
            id: base64urlToBuffer(id),
            type: 'public-key',
            transports: ['internal'],
          }));

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

        // Step 3: Send assertion to backend (origin is verified server-side
        // from the signed clientDataJSON — never a client-declared field)
        const verifyData = await graphqlRequest(VERIFY_LOGIN_MUTATION, {
          input: {
            credentialId: bufferToBase64url(assertion.rawId),
            authenticatorData: bufferToBase64url(assertionResponse.authenticatorData),
            clientDataJSON: bufferToBase64url(assertionResponse.clientDataJSON),
            signature: bufferToBase64url(assertionResponse.signature),
            ...(assertionResponse.userHandle
              ? { userHandle: bufferToBase64url(assertionResponse.userHandle) }
              : {}),
            challenge: challengeResponse.challenge,
          },
        });

        return verifyData.verifyWebAuthnLogin;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Biometric login failed';
        if (
          message.includes('AbortError') ||
          message.includes('cancelled') ||
          message.includes('NotAllowedError')
        ) {
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

/**
 * SSoT parse for the stored credential-id list. JSON.parse returns `any`, so the
 * result is validated to be a string[] here (anything else → []) — this keeps the
 * three call sites off the `any` path (no-unsafe-assignment) without each
 * re-implementing the guard.
 */
function readStoredCredentialIds(): string[] {
  try {
    const stored = localStorage.getItem(CREDENTIAL_IDS_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // localStorage not available / malformed JSON — treat as empty.
    return [];
  }
}

function saveCredentialIdLocally(credentialId: string): void {
  try {
    const ids = readStoredCredentialIds();
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
    const filtered = readStoredCredentialIds().filter((id) => id !== credentialId);
    localStorage.setItem(CREDENTIAL_IDS_KEY, JSON.stringify(filtered));
  } catch {
    // localStorage not available — not critical
  }
}

/**
 * Check if there are locally stored credential IDs.
 * This enables showing the biometric login button without a network request.
 */
export function hasLocalCredentials(): boolean {
  return readStoredCredentialIds().length > 0;
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
