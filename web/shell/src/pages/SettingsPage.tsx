/**
 * Settings Page
 *
 * User settings with tabbed navigation:
 * - Profile: Edit name, email, avatar
 * - Security: Change password, MFA setup/disable, WebAuthn credentials
 * - Preferences: Theme, language, notifications (placeholder)
 * - Privacy: GDPR consent management (view/toggle/withdraw consents, history)
 */

import {
  useAuthContext,
  Button,
  Input,
  Alert,
  Card,
  Modal,
  useToast,
  graphqlClient,
} from '@aquaculture/shared-ui';
import React, { useState, useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { QrCode } from '../components/QrCode';
import {
  CHANGE_MY_PASSWORD,
  DISABLE_MFA,
  GET_MY_NOTIFICATION_PREFERENCES,
  MY_SECURITY_SETTINGS,
  MY_WEBAUTHN_CREDENTIALS,
  REGENERATE_MFA_RECOVERY_CODES,
  REMOVE_WEBAUTHN_CREDENTIAL,
  SETUP_MFA,
  UPDATE_MY_NOTIFICATION_PREFERENCES,
  UPDATE_MY_PROFILE,
  VERIFY_MFA_SETUP,
} from '../graphql/settings.operations';
import {
  type ThemePreference,
  getStoredThemePreference,
  persistThemePreference,
  resolveThemePreference,
  subscribeToSystemThemePreference,
} from '../utils/theme';

import ConsentSettingsPage from './ConsentSettingsPage';

// ============================================================================
// Types
// ============================================================================

type SettingsTab = 'profile' | 'security' | 'preferences' | 'privacy';

interface WebAuthnCredential {
  credentialId: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string;
}

interface MfaSetupData {
  secret: string;
  qrCodeUri: string;
  recoveryCodes: string[];
}

interface MySecuritySettingsData {
  mfaEnabled: boolean;
  mfaAvailable: boolean;
  mfaUnavailableReason?: string | null;
}

const PASSWORD_POLICY_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,128}$/;
const PASSWORD_POLICY_MESSAGE =
  'Use at least 8 characters with uppercase, lowercase, number, and special character.';

// ============================================================================
// Tab Configuration
// ============================================================================

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  {
    id: 'profile',
    label: 'Profile',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>
    ),
  },
  {
    id: 'security',
    label: 'Security',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
  },
  {
    id: 'preferences',
    label: 'Preferences',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
      </svg>
    ),
  },
  {
    id: 'privacy',
    label: 'Privacy',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
  },
];

// ============================================================================
// Shared Props
// ============================================================================

interface TabProps {
  showToast: (options: { title: string; description?: string; variant?: 'success' | 'error' | 'warning' | 'info' }) => void;
}

// ============================================================================
// Profile Tab
// ============================================================================

const ProfileTab: React.FC<TabProps> = ({ showToast }) => {
  const { user, refreshAuth } = useAuthContext();

  const [formData, setFormData] = useState({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    email: user?.email || '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  // Sync form data when user changes
  useEffect(() => {
    if (user) {
      setFormData({
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        email: user.email || '',
      });
    }
  }, [user]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: '' }));
    setSuccessMessage('');
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const newErrors: Record<string, string> = {};
      if (!formData.firstName.trim()) newErrors.firstName = 'First name is required';
      if (!formData.lastName.trim()) newErrors.lastName = 'Last name is required';

      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors);
        return;
      }

      setIsSubmitting(true);
      setSuccessMessage('');

      try {
        await graphqlClient.request(UPDATE_MY_PROFILE, {
          input: {
            firstName: formData.firstName.trim(),
            lastName: formData.lastName.trim(),
          },
        });

        await refreshAuth();
        setSuccessMessage('Profile updated successfully.');
        showToast({ title: 'Profile Updated', description: 'Your profile has been saved.', variant: 'success' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update profile';
        setErrors({ submit: message });
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, refreshAuth, showToast]
  );

  return (
    <div className="space-y-6">
      {/* Avatar Section */}
      <Card>
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Profile Picture</h3>
          <div className="flex items-center gap-6">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white text-2xl font-bold shadow-lg">
              {(user?.firstName?.[0] || user?.email?.[0] || '?').toUpperCase()}
            </div>
            <div>
              <p className="text-sm text-gray-600 mb-2">
                {user?.firstName && user?.lastName
                  ? `${user.firstName} ${user.lastName}`
                  : user?.email}
              </p>
              <p className="text-xs text-gray-400">
                Avatar changes will be available in a future update.
              </p>
            </div>
          </div>
        </div>
      </Card>

      {/* Profile Form */}
      <Card>
        <form onSubmit={(event) => {
          void handleSubmit(event);
        }} className="p-6 space-y-5">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Personal Information</h3>

          {successMessage && (
            <Alert type="success" dismissible onDismiss={() => setSuccessMessage('')}>
              {successMessage}
            </Alert>
          )}

          {errors.submit && (
            <Alert type="error" dismissible onDismiss={() => setErrors((prev) => ({ ...prev, submit: '' }))}>
              {errors.submit}
            </Alert>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="First Name"
              name="firstName"
              value={formData.firstName}
              onChange={handleChange}
              placeholder="First name"
              error={errors.firstName}
              required
            />
            <Input
              label="Last Name"
              name="lastName"
              value={formData.lastName}
              onChange={handleChange}
              placeholder="Last name"
              error={errors.lastName}
              required
            />
          </div>

          <Input
            label="Email"
            type="email"
            name="email"
            value={formData.email}
            placeholder="email@example.com"
            helperText="Email changes require a verified email workflow."
            readOnly
            disabled
          />

          <div className="flex justify-end pt-2">
            <Button type="submit" loading={isSubmitting}>
              Save Changes
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
};

// ============================================================================
// Security Tab
// ============================================================================

const SecurityTab: React.FC<TabProps> = ({ showToast }) => {
  const { user, refreshAuth } = useAuthContext();

  // Password change state
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState('');

  // MFA state
  const [mfaSetupData, setMfaSetupData] = useState<MfaSetupData | null>(null);
  const [mfaSetupCode, setMfaSetupCode] = useState('');
  const [mfaSetupError, setMfaSetupError] = useState('');
  const [isSettingUpMfa, setIsSettingUpMfa] = useState(false);
  const [showMfaSetup, setShowMfaSetup] = useState(false);
  const [showRecoveryCodes, setShowRecoveryCodes] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  // MFA disable state
  const [showDisableMfa, setShowDisableMfa] = useState(false);
  const [disableMfaForm, setDisableMfaForm] = useState({ password: '', code: '' });
  const [disableMfaError, setDisableMfaError] = useState('');
  const [isDisablingMfa, setIsDisablingMfa] = useState(false);

  // WebAuthn state
  const [webAuthnCredentials, setWebAuthnCredentials] = useState<WebAuthnCredential[]>([]);
  const [isLoadingCredentials, setIsLoadingCredentials] = useState(false);
  const [webAuthnError, setWebAuthnError] = useState('');

  const fetchWebAuthnCredentials = useCallback(async () => {
    setIsLoadingCredentials(true);
    try {
      const response = await graphqlClient.request<{
        myWebAuthnCredentials: WebAuthnCredential[];
      }>(MY_WEBAUTHN_CREDENTIALS);
      setWebAuthnCredentials(response?.myWebAuthnCredentials || []);
    } catch {
      // Silently fail -- credentials may not be supported
    } finally {
      setIsLoadingCredentials(false);
    }
  }, []);

  // Fetch WebAuthn credentials on mount
  useEffect(() => {
    void fetchWebAuthnCredentials();
  }, [fetchWebAuthnCredentials]);

  const [securitySettings, setSecuritySettings] = useState<MySecuritySettingsData>({
    mfaEnabled: false,
    mfaAvailable: false,
    mfaUnavailableReason: 'Security settings have not loaded yet.',
  });
  const [isLoadingSecuritySettings, setIsLoadingSecuritySettings] = useState(true);
  const [securitySettingsError, setSecuritySettingsError] = useState('');

  const refreshSecuritySettings = useCallback(async () => {
    setIsLoadingSecuritySettings(true);
    setSecuritySettingsError('');
    try {
      const response = await graphqlClient.request<{
        mySecuritySettings: MySecuritySettingsData;
      }>(MY_SECURITY_SETTINGS);
      if (response?.mySecuritySettings) {
        setSecuritySettings(response.mySecuritySettings);
      } else {
        setSecuritySettings({
          mfaEnabled: false,
          mfaAvailable: false,
          mfaUnavailableReason: 'Security settings are unavailable.',
        });
        setSecuritySettingsError('Security settings are unavailable.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load security settings';
      setSecuritySettings({
        mfaEnabled: false,
        mfaAvailable: false,
        mfaUnavailableReason: message,
      });
      setSecuritySettingsError(message);
    } finally {
      setIsLoadingSecuritySettings(false);
    }
  }, []);

  useEffect(() => {
    void refreshSecuritySettings();
  }, [user, refreshSecuritySettings]);

  const mfaEnabled = securitySettings.mfaEnabled;
  const mfaAvailable = securitySettings.mfaAvailable;

  // ── Password Change ─────────────────────────────────────────────────────

  const handlePasswordChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setPasswordForm((prev) => ({ ...prev, [name]: value }));
    setPasswordErrors((prev) => ({ ...prev, [name]: '' }));
    setPasswordSuccess('');
  }, []);

  const handlePasswordSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const newErrors: Record<string, string> = {};
      if (!passwordForm.currentPassword) newErrors.currentPassword = 'Current password is required';
      if (!passwordForm.newPassword) newErrors.newPassword = 'New password is required';
      if (passwordForm.newPassword && !PASSWORD_POLICY_REGEX.test(passwordForm.newPassword)) {
        newErrors.newPassword = PASSWORD_POLICY_MESSAGE;
      }
      if (passwordForm.newPassword !== passwordForm.confirmPassword) {
        newErrors.confirmPassword = 'Passwords do not match';
      }

      if (Object.keys(newErrors).length > 0) {
        setPasswordErrors(newErrors);
        return;
      }

      setIsChangingPassword(true);
      setPasswordSuccess('');

      try {
        await graphqlClient.request(CHANGE_MY_PASSWORD, {
          input: {
            currentPassword: passwordForm.currentPassword,
            newPassword: passwordForm.newPassword,
          },
        });

        setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
        setPasswordSuccess('Password changed successfully.');
        showToast({ title: 'Password Changed', description: 'Your password has been updated.', variant: 'success' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to change password';
        setPasswordErrors({ submit: message });
      } finally {
        setIsChangingPassword(false);
      }
    },
    [passwordForm, showToast]
  );

  // ── MFA Setup ───────────────────────────────────────────────────────────

  const handleSetupMfa = useCallback(async () => {
    setIsSettingUpMfa(true);
    setMfaSetupError('');

    try {
      const settingsResponse = await graphqlClient.request<{
        mySecuritySettings: MySecuritySettingsData;
      }>(MY_SECURITY_SETTINGS);
      const latestSettings = settingsResponse?.mySecuritySettings;
      if (!latestSettings?.mfaAvailable) {
        const reason = latestSettings?.mfaUnavailableReason || 'Two-factor authentication is unavailable.';
        setSecuritySettings({
          mfaEnabled: latestSettings?.mfaEnabled ?? false,
          mfaAvailable: false,
          mfaUnavailableReason: reason,
        });
        throw new Error(reason);
      }

      setSecuritySettings(latestSettings);
      const response = await graphqlClient.request<{
        setupMfa: MfaSetupData;
      }>(SETUP_MFA);

      if (response?.setupMfa) {
        setMfaSetupData(response.setupMfa);
        setShowMfaSetup(true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to initiate MFA setup';
      setMfaSetupError(message);
    } finally {
      setIsSettingUpMfa(false);
    }
  }, []);

  const handleVerifyMfaSetup = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const code = mfaSetupCode.trim();
      if (!code || !/^\d{6}$/.test(code)) {
        setMfaSetupError('Enter a 6-digit code from your authenticator app');
        return;
      }

      setIsSettingUpMfa(true);
      setMfaSetupError('');

      try {
        await graphqlClient.request(VERIFY_MFA_SETUP, {
          input: { code },
        });

        // Show recovery codes
        setRecoveryCodes(mfaSetupData?.recoveryCodes || []);
        setShowRecoveryCodes(true);
        setShowMfaSetup(false);
        setMfaSetupData(null);
        setMfaSetupCode('');

        await refreshAuth();
        await refreshSecuritySettings();
        showToast({
          title: 'MFA Enabled',
          description: 'Two-factor authentication has been enabled on your account.',
          variant: 'success',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to verify MFA code';
        setMfaSetupError(message);
      } finally {
        setIsSettingUpMfa(false);
      }
    },
    [mfaSetupCode, mfaSetupData, refreshAuth, refreshSecuritySettings, showToast]
  );

  const handleCancelMfaSetup = useCallback(() => {
    setShowMfaSetup(false);
    setMfaSetupData(null);
    setMfaSetupCode('');
    setMfaSetupError('');
  }, []);

  // ── MFA Disable ─────────────────────────────────────────────────────────

  const handleDisableMfa = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!disableMfaForm.password || !disableMfaForm.code) {
        setDisableMfaError('Password and TOTP code are required');
        return;
      }

      if (!/^\d{6}$/.test(disableMfaForm.code.trim())) {
        setDisableMfaError('Enter a 6-digit code from your authenticator app');
        return;
      }

      setIsDisablingMfa(true);
      setDisableMfaError('');

      try {
        await graphqlClient.request(DISABLE_MFA, {
          input: {
            password: disableMfaForm.password,
            code: disableMfaForm.code.trim(),
          },
        });

        setShowDisableMfa(false);
        setDisableMfaForm({ password: '', code: '' });
        await refreshAuth();
        await refreshSecuritySettings();
        showToast({
          title: 'MFA Disabled',
          description: 'Two-factor authentication has been disabled.',
          variant: 'success',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to disable MFA';
        setDisableMfaError(message);
      } finally {
        setIsDisablingMfa(false);
      }
    },
    [disableMfaForm, refreshAuth, refreshSecuritySettings, showToast]
  );

  // ── Regenerate Recovery Codes ───────────────────────────────────────────

  const [regenCode, setRegenCode] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showRegenModal, setShowRegenModal] = useState(false);
  const [regenError, setRegenError] = useState('');

  const handleRegenerateRecoveryCodes = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const code = regenCode.trim();
      if (!code || !/^\d{6}$/.test(code)) {
        setRegenError('Enter a 6-digit code from your authenticator app');
        return;
      }

      setIsRegenerating(true);
      setRegenError('');

      try {
        const response = await graphqlClient.request<{
          regenerateMfaRecoveryCodes: { recoveryCodes: string[] };
        }>(REGENERATE_MFA_RECOVERY_CODES, { code });

        if (response?.regenerateMfaRecoveryCodes) {
          setRecoveryCodes(response.regenerateMfaRecoveryCodes.recoveryCodes);
          setShowRecoveryCodes(true);
          setShowRegenModal(false);
          setRegenCode('');
          showToast({
            title: 'Recovery Codes Regenerated',
            description: 'Previous codes have been invalidated.',
            variant: 'success',
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to regenerate recovery codes';
        setRegenError(message);
      } finally {
        setIsRegenerating(false);
      }
    },
    [regenCode, showToast]
  );

  // ── WebAuthn Remove ─────────────────────────────────────────────────────

  const handleRemoveWebAuthn = useCallback(
    async (credentialId: string) => {
      try {
        await graphqlClient.request(REMOVE_WEBAUTHN_CREDENTIAL, { credentialId });
        setWebAuthnCredentials((prev) => prev.filter((c) => c.credentialId !== credentialId));
        showToast({ title: 'Credential Removed', description: 'Biometric credential has been removed.', variant: 'success' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to remove credential';
        setWebAuthnError(message);
      }
    },
    [showToast]
  );

  return (
    <div className="space-y-6">
      {/* Change Password */}
      <Card>
        <form onSubmit={(event) => {
          void handlePasswordSubmit(event);
        }} className="p-6 space-y-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Change Password</h3>
              <p className="text-sm text-gray-500">Update your password to keep your account secure</p>
            </div>
          </div>

          {passwordSuccess && (
            <Alert type="success" dismissible onDismiss={() => setPasswordSuccess('')}>
              {passwordSuccess}
            </Alert>
          )}

          {passwordErrors.submit && (
            <Alert type="error" dismissible onDismiss={() => setPasswordErrors((prev) => ({ ...prev, submit: '' }))}>
              {passwordErrors.submit}
            </Alert>
          )}

          <Input
            label="Current Password"
            type="password"
            name="currentPassword"
            value={passwordForm.currentPassword}
            onChange={handlePasswordChange}
            placeholder="Enter current password"
            error={passwordErrors.currentPassword}
            autoComplete="current-password"
            required
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="New Password"
              type="password"
              name="newPassword"
              value={passwordForm.newPassword}
              onChange={handlePasswordChange}
              placeholder="New password"
              helperText="Min 8 chars with uppercase, lowercase, number, and @$!%*?&."
              error={passwordErrors.newPassword}
              autoComplete="new-password"
              required
            />
            <Input
              label="Confirm New Password"
              type="password"
              name="confirmPassword"
              value={passwordForm.confirmPassword}
              onChange={handlePasswordChange}
              placeholder="Re-enter new password"
              error={passwordErrors.confirmPassword}
              autoComplete="new-password"
              required
            />
          </div>

          <div className="flex justify-end pt-2">
            <Button type="submit" loading={isChangingPassword}>
              Update Password
            </Button>
          </div>
        </form>
      </Card>

      {/* Two-Factor Authentication (MFA) */}
      <Card>
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Two-Factor Authentication</h3>
                <p className="text-sm text-gray-500">Add an extra layer of security to your account</p>
              </div>
            </div>
            <span
              className={`px-3 py-1 rounded-full text-xs font-medium ${
                mfaEnabled && mfaAvailable
                  ? 'bg-green-100 text-green-800'
                  : mfaEnabled && !mfaAvailable
                    ? 'bg-red-100 text-red-800'
                  : 'bg-gray-100 text-gray-600'
              }`}
            >
              {mfaEnabled ? (mfaAvailable ? 'Enabled' : 'Unavailable') : 'Disabled'}
            </span>
          </div>

          {securitySettingsError && (
            <Alert type="error" dismissible onDismiss={() => setSecuritySettingsError('')}>
              {securitySettingsError}
            </Alert>
          )}

          {!mfaAvailable && (
            <Alert type="warning">
              {securitySettings.mfaUnavailableReason || 'Two-factor authentication is unavailable in this environment.'}
            </Alert>
          )}

          {mfaSetupError && (
            <Alert type="error" dismissible onDismiss={() => setMfaSetupError('')}>
              {mfaSetupError}
            </Alert>
          )}

          {!mfaEnabled ? (
            <div className="mt-4">
              <p className="text-sm text-gray-600 mb-4">
                Use an authenticator app (like Google Authenticator, Authy, or 1Password) to generate
                one-time verification codes for additional security.
              </p>
              <Button
                onClick={() => {
                  void handleSetupMfa();
                }}
                loading={isSettingUpMfa}
                variant="primary"
                disabled={isLoadingSecuritySettings || !mfaAvailable}
              >
                Enable Two-Factor Authentication
              </Button>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                onClick={() => setShowRegenModal(true)}
                variant="outline"
                disabled={isLoadingSecuritySettings || !mfaAvailable}
              >
                Regenerate Recovery Codes
              </Button>
              <Button
                onClick={() => setShowDisableMfa(true)}
                variant="danger"
                disabled={isLoadingSecuritySettings || !mfaAvailable}
              >
                Disable MFA
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* WebAuthn / Biometric Credentials */}
      <Card>
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004.5 10.5a7.464 7.464 0 01-1.15 3.993m1.989 3.559A11.209 11.209 0 008.25 10.5a3.75 3.75 0 117.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 01-3.6 9.75m6.633-4.596a18.666 18.666 0 01-2.485 5.33" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Biometric / Passkey Credentials</h3>
              <p className="text-sm text-gray-500">Manage your registered biometric login devices</p>
            </div>
          </div>

          {webAuthnError && (
            <Alert type="error" dismissible onDismiss={() => setWebAuthnError('')}>
              {webAuthnError}
            </Alert>
          )}

          {isLoadingCredentials ? (
            <div className="py-8 text-center text-sm text-gray-500">Loading credentials...</div>
          ) : webAuthnCredentials.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-500 mb-2">No biometric credentials registered.</p>
              <p className="text-xs text-gray-400">
                You can register biometric login from a supported browser and device.
              </p>
            </div>
          ) : (
            <div className="space-y-3 mt-4">
              {webAuthnCredentials.map((credential) => (
                <div
                  key={credential.credentialId}
                  className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                      <svg className="w-4 h-4 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004.5 10.5a7.464 7.464 0 01-1.15 3.993m1.989 3.559A11.209 11.209 0 008.25 10.5a3.75 3.75 0 117.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 01-3.6 9.75m6.633-4.596a18.666 18.666 0 01-2.485 5.33" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{credential.deviceName || 'Unnamed Device'}</p>
                      <p className="text-xs text-gray-500">
                        Registered {new Date(credential.createdAt).toLocaleDateString()}
                        {credential.lastUsedAt && ` · Last used ${new Date(credential.lastUsedAt).toLocaleDateString()}`}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void handleRemoveWebAuthn(credential.credentialId);
                    }}
                    className="text-red-500 hover:text-red-700 text-sm font-medium transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* MFA Setup Modal */}
      <Modal
        isOpen={showMfaSetup}
        onClose={handleCancelMfaSetup}
        title="Set Up Two-Factor Authentication"
        size="md"
      >
        <form onSubmit={(event) => {
          void handleVerifyMfaSetup(event);
        }} className="space-y-5">
          {mfaSetupData && (
            <>
              <div className="text-center">
                <p className="text-sm text-gray-600 mb-4">
                  Scan this QR code with your authenticator app, then enter the 6-digit code below.
                </p>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
                  <QrCode value={mfaSetupData.qrCodeUri} className="mx-auto w-48 h-48" />
                </div>
                <details className="text-left">
                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                    Can&apos;t scan? Enter this key manually
                  </summary>
                  <code className="block mt-2 p-2 bg-gray-100 rounded text-xs font-mono text-gray-800 break-all select-all">
                    {mfaSetupData.secret}
                  </code>
                </details>
              </div>

              {mfaSetupError && (
                <Alert type="error" dismissible onDismiss={() => setMfaSetupError('')}>
                  {mfaSetupError}
                </Alert>
              )}

              <Input
                label="Verification Code"
                type="text"
                inputMode="numeric"
                value={mfaSetupCode}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                  setMfaSetupCode(val);
                  setMfaSetupError('');
                }}
                placeholder="000000"
                maxLength={6}
                autoComplete="one-time-code"
                required
              />

              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={handleCancelMfaSetup}>
                  Cancel
                </Button>
                <Button type="submit" loading={isSettingUpMfa}>
                  Verify & Enable
                </Button>
              </div>
            </>
          )}
        </form>
      </Modal>

      {/* Recovery Codes Modal */}
      <Modal
        isOpen={showRecoveryCodes}
        onClose={() => setShowRecoveryCodes(false)}
        title="Recovery Codes"
        size="md"
      >
        <div className="space-y-4">
          <Alert type="warning">
            Save these recovery codes in a safe place. Each code can only be used once.
            If you lose access to your authenticator app, you can use these codes to log in.
          </Alert>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <div className="grid grid-cols-2 gap-2">
              {recoveryCodes.map((code, index) => (
                <code key={index} className="text-sm font-mono text-gray-800 p-1 select-all">
                  {code}
                </code>
              ))}
            </div>
          </div>

          <div className="flex justify-between items-center">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(recoveryCodes.join('\n'));
                showToast({ title: 'Copied', description: 'Recovery codes copied to clipboard.', variant: 'info' });
              }}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              Copy All
            </button>
            <Button onClick={() => setShowRecoveryCodes(false)}>
              Done
            </Button>
          </div>
        </div>
      </Modal>

      {/* Disable MFA Modal */}
      <Modal
        isOpen={showDisableMfa}
        onClose={() => {
          setShowDisableMfa(false);
          setDisableMfaForm({ password: '', code: '' });
          setDisableMfaError('');
        }}
        title="Disable Two-Factor Authentication"
        size="sm"
      >
        <form onSubmit={(event) => {
          void handleDisableMfa(event);
        }} className="space-y-4">
          <Alert type="warning">
            Disabling MFA will make your account less secure. You will need your password and a
            current TOTP code to proceed.
          </Alert>

          {disableMfaError && (
            <Alert type="error" dismissible onDismiss={() => setDisableMfaError('')}>
              {disableMfaError}
            </Alert>
          )}

          <Input
            label="Password"
            type="password"
            value={disableMfaForm.password}
            onChange={(e) => {
              setDisableMfaForm((prev) => ({ ...prev, password: e.target.value }));
              setDisableMfaError('');
            }}
            placeholder="Enter your password"
            autoComplete="current-password"
            required
          />

          <Input
            label="TOTP Code"
            type="text"
            inputMode="numeric"
            value={disableMfaForm.code}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, '').slice(0, 6);
              setDisableMfaForm((prev) => ({ ...prev, code: val }));
              setDisableMfaError('');
            }}
            placeholder="000000"
            maxLength={6}
            autoComplete="one-time-code"
            required
          />

          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowDisableMfa(false);
                setDisableMfaForm({ password: '', code: '' });
                setDisableMfaError('');
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={isDisablingMfa}>
              Disable MFA
            </Button>
          </div>
        </form>
      </Modal>

      {/* Regenerate Recovery Codes Modal */}
      <Modal
        isOpen={showRegenModal}
        onClose={() => {
          setShowRegenModal(false);
          setRegenCode('');
          setRegenError('');
        }}
        title="Regenerate Recovery Codes"
        size="sm"
      >
        <form onSubmit={(event) => {
          void handleRegenerateRecoveryCodes(event);
        }} className="space-y-4">
          <Alert type="warning">
            Regenerating recovery codes will invalidate all existing codes. Enter a TOTP code to confirm.
          </Alert>

          {regenError && (
            <Alert type="error" dismissible onDismiss={() => setRegenError('')}>
              {regenError}
            </Alert>
          )}

          <Input
            label="TOTP Code"
            type="text"
            inputMode="numeric"
            value={regenCode}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, '').slice(0, 6);
              setRegenCode(val);
              setRegenError('');
            }}
            placeholder="000000"
            maxLength={6}
            autoComplete="one-time-code"
            required
          />

          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowRegenModal(false);
                setRegenCode('');
                setRegenError('');
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={isRegenerating}>
              Regenerate
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

// ============================================================================
// Preferences Tab
// ============================================================================

const PreferencesTab: React.FC<TabProps> = ({ showToast }) => {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => getStoredThemePreference());
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    resolveThemePreference(getStoredThemePreference()),
  );
  const [notifPrefs, setNotifPrefs] = useState({
    emailEnabled: true,
    smsEnabled: false,
    pushEnabled: false,
    quietHoursStart: '',
    quietHoursEnd: '',
    quietHoursTimezone: 'Europe/Istanbul',
    alertNotifications: true,
    taskNotifications: true,
    systemNotifications: true,
  });
  const [notifLoading, setNotifLoading] = useState(true);
  const [notifSaving, setNotifSaving] = useState(false);

  useEffect(() => {
    return subscribeToSystemThemePreference(
      () => themePreference,
      (theme) => setResolvedTheme(theme),
    );
  }, [themePreference]);

  const updateThemePreference = (preference: ThemePreference): void => {
    setThemePreference(preference);
    setResolvedTheme(persistThemePreference(preference));
    showToast({ title: 'Saved', description: 'Appearance preference updated.', variant: 'success' });
  };

  // Load notification preferences on mount
  useEffect(() => {
    graphqlClient.request<{ getMyNotificationPreferences: typeof notifPrefs }>(GET_MY_NOTIFICATION_PREFERENCES)
      .then((data) => {
        const p = data.getMyNotificationPreferences;
        setNotifPrefs({
          emailEnabled: p.emailEnabled,
          smsEnabled: p.smsEnabled,
          pushEnabled: p.pushEnabled,
          quietHoursStart: p.quietHoursStart || '',
          quietHoursEnd: p.quietHoursEnd || '',
          quietHoursTimezone: p.quietHoursTimezone || 'Europe/Istanbul',
          alertNotifications: p.alertNotifications,
          taskNotifications: p.taskNotifications,
          systemNotifications: p.systemNotifications,
        });
      })
      .catch(() => {
        // Use defaults on error
      })
      .finally(() => setNotifLoading(false));
  }, []);

  const updatePref = <K extends keyof typeof notifPrefs>(key: K, value: (typeof notifPrefs)[K]): void => {
    setNotifPrefs((prev) => ({ ...prev, [key]: value }));
  };

  const saveNotifPrefs = async (): Promise<void> => {
    setNotifSaving(true);
    try {
      await graphqlClient.request(UPDATE_MY_NOTIFICATION_PREFERENCES, {
        input: {
          emailEnabled: notifPrefs.emailEnabled,
          smsEnabled: notifPrefs.smsEnabled,
          pushEnabled: notifPrefs.pushEnabled,
          quietHoursStart: notifPrefs.quietHoursStart || null,
          quietHoursEnd: notifPrefs.quietHoursEnd || null,
          quietHoursTimezone: notifPrefs.quietHoursTimezone,
          alertNotifications: notifPrefs.alertNotifications,
          taskNotifications: notifPrefs.taskNotifications,
          systemNotifications: notifPrefs.systemNotifications,
        },
      });
      showToast({ title: 'Saved', description: 'Notification preferences updated.', variant: 'success' });
    } catch (err) {
      showToast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to save notification preferences',
        variant: 'error',
      });
    } finally {
      setNotifSaving(false);
    }
  };

  const NotifToggle: React.FC<{ enabled: boolean; onChange: (v: boolean) => void; label: string; desc: string }> = ({ enabled, onChange, label, desc }) => (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <p className="text-xs text-gray-500">{desc}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
          enabled ? 'bg-blue-600' : 'bg-gray-300'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
            enabled ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Theme */}
      <Card>
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Appearance</h3>
              <p className="text-sm text-gray-500">Customize the look and feel of the application</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 max-w-md">
            {[
              { id: 'light', label: 'Light' },
              { id: 'dark', label: 'Dark' },
              { id: 'system', label: 'System' },
            ].map((theme) => (
              <button
                key={theme.id}
                type="button"
                onClick={() => updateThemePreference(theme.id as ThemePreference)}
                className={`p-3 rounded-lg border-2 text-center text-sm font-medium transition-all ${
                  themePreference === theme.id
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
                aria-pressed={themePreference === theme.id}
              >
                {theme.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Current theme: {resolvedTheme === 'dark' ? 'Dark' : 'Light'}
          </p>
        </div>
      </Card>

      {/* Language */}
      <Card>
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-teal-100 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Language</h3>
              <p className="text-sm text-gray-500">Choose your preferred language</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 max-w-md">
            {[
              { code: 'tr', label: 'Turkish', flag: 'TR' },
              { code: 'en', label: 'English', flag: 'EN' },
            ].map((lang) => (
              <button
                key={lang.code}
                type="button"
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 text-sm font-medium transition-all ${
                  lang.code === 'tr'
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 opacity-50 cursor-not-allowed'
                }`}
                disabled={lang.code !== 'tr'}
              >
                <span className="text-xs font-bold px-1.5 py-0.5 bg-gray-100 rounded">{lang.flag}</span>
                {lang.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-3">Multi-language support coming soon.</p>
        </div>
      </Card>

      {/* Notifications */}
      <Card>
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Notifications</h3>
              <p className="text-sm text-gray-500">Manage how you receive notifications</p>
            </div>
          </div>

          {notifLoading ? (
            <div className="flex items-center justify-center py-6">
              <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* Channel toggles */}
              <div className="mb-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Channels</p>
                <div className="divide-y divide-gray-100">
                  <NotifToggle enabled={notifPrefs.emailEnabled} onChange={(v) => updatePref('emailEnabled', v)} label="Email Notifications" desc="Receive notifications via email" />
                  <NotifToggle enabled={notifPrefs.smsEnabled} onChange={(v) => updatePref('smsEnabled', v)} label="SMS Notifications" desc="Receive critical alerts via text message" />
                  <NotifToggle enabled={notifPrefs.pushEnabled} onChange={(v) => updatePref('pushEnabled', v)} label="Push Notifications" desc="Push notifications on your devices" />
                </div>
              </div>

              {/* Category toggles */}
              <div className="mb-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Categories</p>
                <div className="divide-y divide-gray-100">
                  <NotifToggle enabled={notifPrefs.alertNotifications} onChange={(v) => updatePref('alertNotifications', v)} label="Sensor Alerts" desc="Sensor threshold breaches and critical alerts" />
                  <NotifToggle enabled={notifPrefs.taskNotifications} onChange={(v) => updatePref('taskNotifications', v)} label="Task Notifications" desc="Task assignments, updates, and reminders" />
                  <NotifToggle enabled={notifPrefs.systemNotifications} onChange={(v) => updatePref('systemNotifications', v)} label="System Notifications" desc="System updates, maintenance, and reports" />
                </div>
              </div>

              {/* Quiet hours */}
              <div className="mb-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Quiet Hours</p>
                <p className="text-xs text-gray-500 mb-3">Suppress non-critical notifications during specified hours.</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label htmlFor="quiet-hours-start" className="block text-xs font-medium text-gray-600 mb-1">Start</label>
                    <input
                      id="quiet-hours-start"
                      type="time"
                      value={notifPrefs.quietHoursStart}
                      onChange={(e) => updatePref('quietHoursStart', e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label htmlFor="quiet-hours-end" className="block text-xs font-medium text-gray-600 mb-1">End</label>
                    <input
                      id="quiet-hours-end"
                      type="time"
                      value={notifPrefs.quietHoursEnd}
                      onChange={(e) => updatePref('quietHoursEnd', e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label htmlFor="quiet-hours-timezone" className="block text-xs font-medium text-gray-600 mb-1">Timezone</label>
                    <select
                      id="quiet-hours-timezone"
                      value={notifPrefs.quietHoursTimezone}
                      onChange={(e) => updatePref('quietHoursTimezone', e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      <option value="Europe/Istanbul">Istanbul (UTC+3)</option>
                      <option value="UTC">UTC</option>
                      <option value="America/New_York">New York (UTC-5)</option>
                      <option value="America/Los_Angeles">Los Angeles (UTC-8)</option>
                      <option value="Europe/London">London (UTC+0/+1)</option>
                      <option value="Europe/Berlin">Berlin (UTC+1/+2)</option>
                      <option value="Asia/Tokyo">Tokyo (UTC+9)</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Save button */}
              <Button
                onClick={() => {
                  void saveNotifPrefs();
                }}
                disabled={notifSaving}
                className="mt-2"
              >
                {notifSaving ? 'Saving...' : 'Save Notification Preferences'}
              </Button>
            </>
          )}
        </div>
      </Card>
    </div>
  );
};

// ============================================================================
// Main Settings Page
// ============================================================================

const SettingsPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();

  // Determine active tab from URL
  const getActiveTab = useCallback((): SettingsTab => {
    const path = location.pathname;
    if (path.includes('/settings/profile')) return 'profile';
    if (path.includes('/settings/security')) return 'security';
    if (path.includes('/settings/preferences')) return 'preferences';
    if (path.includes('/settings/privacy')) return 'privacy';
    return 'profile';
  }, [location.pathname]);

  const [activeTab, setActiveTab] = useState<SettingsTab>(getActiveTab);

  // Sync tab with URL on navigation
  useEffect(() => {
    setActiveTab(getActiveTab());
  }, [getActiveTab]);

  const handleTabChange = useCallback(
    (tab: SettingsTab) => {
      setActiveTab(tab);
      if (tab === 'profile') {
        navigate('/settings/profile', { replace: true });
      } else {
        navigate(`/settings/${tab}`, { replace: true });
      }
    },
    [navigate]
  );

  return (
    <div className="max-w-4xl mx-auto">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">Manage your account settings and preferences</p>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-1 -mb-px">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabChange(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'profile' && <ProfileTab showToast={toast} />}
      {activeTab === 'security' && <SecurityTab showToast={toast} />}
      {activeTab === 'preferences' && <PreferencesTab showToast={toast} />}
      {activeTab === 'privacy' && <ConsentSettingsPage />}
    </div>
  );
};

export default SettingsPage;
