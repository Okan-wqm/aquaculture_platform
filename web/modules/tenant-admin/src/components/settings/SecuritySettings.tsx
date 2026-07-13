import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Save, RefreshCw, AlertCircle, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useToast } from '@aquaculture/shared-ui';
import {
  useTenantSecurityPolicy,
  useUpdateTenantSecurityPolicy,
  type UpdateTenantSecurityPolicyInput,
} from '../../hooks/useTenantSecuritySettings';
import { logError, createErrorToastOptions } from '../../utils/error-handling';
import { Toggle } from './Toggle';

/**
 * SecuritySettings — real, ENFORCED tenant security controls (ADR-045,
 * ADMIN-HIGH-010).
 *
 * Replaces the old "not yet available" stub. Only the two controls the backend
 * actually persists + enforces are rendered:
 *   - enforceMfa (login MFA gate)
 *   - sessionTimeoutMinutes (idle-session timeout; clamps the refresh-token TTL)
 *
 * IP whitelist is deliberately NOT rendered — it is tracked separately as
 * ADMIN-MEDIUM-013 and has no persistence yet, so surfacing an unpersisted
 * control would mislead the admin.
 */

// Server bound (auth-service UpdateTenantSecurityPolicyInput): 5..1440 minutes.
const MIN_SESSION_TIMEOUT = 5;
const MAX_SESSION_TIMEOUT = 1440;

const SecuritySettings: React.FC = () => {
  const { data: policy, isLoading, isError } = useTenantSecurityPolicy();
  const updateMutation = useUpdateTenantSecurityPolicy();
  const { toast } = useToast();

  const [enforceMfa, setEnforceMfa] = useState(false);
  // Raw string so "unset" (platform default) is representable as empty.
  const [timeoutInput, setTimeoutInput] = useState('');

  useEffect(() => {
    if (policy) {
      setEnforceMfa(policy.enforceMfa);
      setTimeoutInput(
        policy.sessionTimeoutMinutes != null ? String(policy.sessionTimeoutMinutes) : '',
      );
    }
  }, [policy]);

  // Client-side validation mirrors the server bound. Empty = "platform default"
  // (the field is left out of the update, so the stored value is unchanged).
  const timeoutError = useMemo<string | null>(() => {
    const raw = timeoutInput.trim();
    if (raw === '') return null;
    if (!/^\d+$/.test(raw)) {
      return 'Session timeout must be a whole number of minutes.';
    }
    const value = Number(raw);
    if (value < MIN_SESSION_TIMEOUT || value > MAX_SESSION_TIMEOUT) {
      return `Session timeout must be between ${MIN_SESSION_TIMEOUT} and ${MAX_SESSION_TIMEOUT} minutes.`;
    }
    return null;
  }, [timeoutInput]);

  // Warn only when the admin is turning MFA ON (it was off in the loaded policy).
  const mfaBeingEnabled = enforceMfa && policy?.enforceMfa === false;

  const handleSave = useCallback(async () => {
    if (timeoutError) return;
    const input: UpdateTenantSecurityPolicyInput = { enforceMfa };
    const raw = timeoutInput.trim();
    if (raw !== '') {
      input.sessionTimeoutMinutes = Number(raw);
    }
    try {
      await updateMutation.mutateAsync(input);
      toast({ variant: 'success', title: 'Security settings saved' });
    } catch (err) {
      logError('SecuritySettings.handleSave', err);
      toast(createErrorToastOptions(err));
    }
  }, [enforceMfa, timeoutInput, timeoutError, updateMutation, toast]);

  const saving = updateMutation.isPending;
  const inputClass =
    'w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed';

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading security settings…
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-red-600 flex items-center gap-1">
        <AlertCircle className="w-4 h-4" />
        Could not load security settings.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* MFA enforcement */}
      <div>
        <div className="flex items-center gap-2 mb-1 text-tenant-700">
          <ShieldCheck className="w-4 h-4" />
          <h3 className="text-sm font-semibold uppercase tracking-wider">Authentication</h3>
        </div>
        <div className="divide-y divide-gray-100">
          <Toggle
            enabled={enforceMfa}
            onChange={setEnforceMfa}
            label="Require MFA for all users"
            description="Every user of this tenant must have multi-factor authentication enrolled to sign in."
          />
        </div>
        {mfaBeingEnabled && (
          <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              Turning this on will sign out any tenant users who do not yet have MFA. They
              will be required to set up MFA before they can log in again.
            </span>
          </div>
        )}
      </div>

      {/* Session timeout */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Session timeout (minutes)
          <span className="ml-2 text-xs font-normal text-gray-400">
            {MIN_SESSION_TIMEOUT}–{MAX_SESSION_TIMEOUT}; leave blank to use the platform default
          </span>
        </label>
        <input
          type="number"
          min={MIN_SESSION_TIMEOUT}
          max={MAX_SESSION_TIMEOUT}
          step={1}
          value={timeoutInput}
          onChange={(e) => setTimeoutInput(e.target.value)}
          placeholder="Platform default"
          aria-invalid={!!timeoutError}
          className={inputClass}
        />
        {timeoutError && (
          <p className="mt-1 text-sm text-red-600 flex items-center gap-1">
            <AlertCircle className="w-4 h-4" />
            {timeoutError}
          </p>
        )}
        <p className="mt-1 text-xs text-gray-500">
          Idle sessions are ended after this many minutes of inactivity.
        </p>
      </div>

      {/* IP whitelist — tracked separately (ADMIN-MEDIUM-013), no persistence yet. */}
      <div className="flex items-start gap-2 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-500">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          <strong>IP whitelisting</strong> is coming soon and is not configurable yet.
        </span>
      </div>

      <div className="flex items-center justify-end gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !!timeoutError}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              Save Changes
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default SecuritySettings;
