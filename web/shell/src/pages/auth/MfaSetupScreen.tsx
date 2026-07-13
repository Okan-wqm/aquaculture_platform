/**
 * MFA setup screen — the pre-session enrollment path (ADR-045).
 *
 * Reached from the login flow when the tenant ENFORCES MFA but the user has none
 * enrolled: login returns `mfaSetupRequired` + a short-lived `mfaSetupToken`
 * (no session tokens). That token authorizes ONLY setupMfa + verifyMfaSetup,
 * which are `@Public` and take the token as an argument — so we call them
 * through `publicGraphqlClient` (the sanctioned pre-session transport: no
 * Authorization/tenant header, no token-lifecycle barrier).
 *
 * On successful verification NO session is issued by design; the user is sent
 * back to sign in, where — with MFA now enrolled — the normal MFA challenge
 * flow completes the login on the single audited token-issuance path.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Alert,
  Button,
  Input,
  publicGraphqlClient,
  type MfaSetupRequiredResult,
} from '@aquaculture/shared-ui';

import { QrCode } from '../../components/QrCode';
import { AuthFormShell } from './AuthFormShell';

interface SetupMfaResponse {
  setupMfa: {
    secret: string;
    qrCodeUri: string;
    recoveryCodes: string[];
  };
}

interface VerifyMfaSetupResponse {
  verifyMfaSetup: {
    success: boolean;
    message?: string | null;
  };
}

// setupMfa / verifyMfaSetup accept the setup token as a GraphQL ARGUMENT
// (both are @Public) — the token identifies the user when no session exists.
const SETUP_MFA_WITH_TOKEN = `
  mutation SetupMfaWithToken($mfaSetupToken: String!) {
    setupMfa(mfaSetupToken: $mfaSetupToken) {
      secret
      qrCodeUri
      recoveryCodes
    }
  }
`;

const VERIFY_MFA_SETUP_WITH_TOKEN = `
  mutation VerifyMfaSetupWithToken($input: VerifyMfaSetupInput!) {
    verifyMfaSetup(input: $input) {
      success
      message
    }
  }
`;

const LockIcon: React.FC = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
  </svg>
);

export interface MfaSetupScreenProps {
  /** The setup credential returned by login (mfaSetupRequired=true). */
  challenge: MfaSetupRequiredResult;
  /** Return to the login screen (cancel, or after a completed enrollment). */
  onBackToLogin: (options?: { enrolled: boolean }) => void;
}

const MfaSetupScreen: React.FC<MfaSetupScreenProps> = ({ challenge, onBackToLogin }) => {
  const [setup, setSetup] = useState<SetupMfaResponse['setupMfa'] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [code, setCode] = useState('');
  const [verifyError, setVerifyError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const initiatedRef = useRef(false);

  // Initiate setup exactly once (StrictMode double-invokes effects in dev).
  useEffect(() => {
    if (initiatedRef.current) return;
    initiatedRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const data = await publicGraphqlClient.request<SetupMfaResponse>(SETUP_MFA_WITH_TOKEN, {
          mfaSetupToken: challenge.mfaSetupToken,
        });
        if (!cancelled) setSetup(data.setupMfa);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error
              ? err.message
              : 'Could not start MFA setup. Please sign in again.',
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [challenge.mfaSetupToken]);

  const handleVerify = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = code.trim();
      if (!/^\d{6}$/.test(trimmed)) {
        setVerifyError('Enter the 6-digit code from your authenticator app.');
        return;
      }

      setIsVerifying(true);
      setVerifyError('');
      try {
        const data = await publicGraphqlClient.request<VerifyMfaSetupResponse>(
          VERIFY_MFA_SETUP_WITH_TOKEN,
          { input: { code: trimmed, mfaSetupToken: challenge.mfaSetupToken } },
        );
        if (data.verifyMfaSetup.success) {
          setEnrolled(true);
        } else {
          setVerifyError(data.verifyMfaSetup.message || 'Verification failed. Please try again.');
        }
      } catch (err) {
        setVerifyError(err instanceof Error ? err.message : 'Verification failed. Please try again.');
        setCode('');
      } finally {
        setIsVerifying(false);
      }
    },
    [code, challenge.mfaSetupToken],
  );

  // ── Success ────────────────────────────────────────────────────────────────
  if (enrolled) {
    return (
      <AuthFormShell titleKey="login.title" icon={<LockIcon />}>
        <div className="space-y-5">
          <Alert type="success">
            Multi-factor authentication is now enabled for your account. Please sign in again
            using your authenticator app.
          </Alert>
          <Button surface="glass" fullWidth onClick={() => onBackToLogin({ enrolled: true })}>
            Back to sign in
          </Button>
        </div>
      </AuthFormShell>
    );
  }

  // ── Load error ───────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <AuthFormShell titleKey="login.title" icon={<LockIcon />} error={loadError}>
        <div className="space-y-5">
          <p className="text-sm text-[var(--surface-muted-fg)]">
            Your organization requires multi-factor authentication, but setup could not be
            started. Please return to sign in and try again.
          </p>
          <Button surface="glass" fullWidth onClick={() => onBackToLogin()}>
            Back to sign in
          </Button>
        </div>
      </AuthFormShell>
    );
  }

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (!setup) {
    return (
      <AuthFormShell titleKey="login.title" icon={<LockIcon />}>
        <p className="text-sm text-center text-[var(--surface-muted-fg)]">
          Preparing multi-factor authentication setup…
        </p>
      </AuthFormShell>
    );
  }

  // ── Setup + verify form ──────────────────────────────────────────────────────
  return (
    <AuthFormShell titleKey="login.title" icon={<LockIcon />} error={verifyError}>
      <div className="space-y-5">
        <p className="text-sm text-[var(--surface-muted-fg)]">
          Your organization requires multi-factor authentication. Scan the QR code with an
          authenticator app (e.g. Google Authenticator or 1Password), then enter the 6-digit
          code to finish setup.
        </p>

        <div className="flex justify-center">
          <QrCode value={setup.qrCodeUri} className="w-44 h-44" />
        </div>

        <div>
          <p className="text-xs text-[var(--surface-muted-fg)] mb-1">
            Can’t scan? Enter this key manually:
          </p>
          <code className="block break-all rounded-lg bg-[var(--surface-field-bg)] px-3 py-2 text-xs text-[var(--surface-heading-fg)]">
            {setup.secret}
          </code>
        </div>

        {setup.recoveryCodes.length > 0 && (
          <div>
            <p className="text-xs font-medium text-[var(--surface-heading-fg)] mb-1">
              Save these recovery codes somewhere safe — each can be used once if you lose your
              device:
            </p>
            <ul className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--surface-field-bg)] px-3 py-2">
              {setup.recoveryCodes.map((rc) => (
                <li key={rc} className="font-mono text-xs text-[var(--surface-heading-fg)]">
                  {rc}
                </li>
              ))}
            </ul>
          </div>
        )}

        <form onSubmit={handleVerify} className="space-y-4">
          <Input
            surface="glass"
            label="Verification code"
            type="text"
            inputMode="numeric"
            name="mfaSetupCode"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
              setVerifyError('');
            }}
            placeholder="000000"
            maxLength={6}
            autoComplete="one-time-code"
            required
          />

          <Button surface="glass" type="submit" fullWidth loading={isVerifying}>
            Enable MFA
          </Button>

          <div className="text-center text-sm pt-1">
            <button
              type="button"
              onClick={() => onBackToLogin()}
              className="font-medium text-[var(--surface-label-fg)] hover:underline"
            >
              Cancel and return to sign in
            </button>
          </div>
        </form>
      </div>
    </AuthFormShell>
  );
};

export default MfaSetupScreen;
