import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Save, Check, RefreshCw, AlertCircle, AlertTriangle, ShieldCheck } from 'lucide-react';

import {
  useTenantSecurityPolicy,
  useUpdateTenantSecurityPolicy,
  type UpdateTenantSecurityPolicyInput,
} from '../../hooks/useTenantSecuritySettings';
import { logError, sanitizeErrorMessage } from '../../utils/error-handling';

import { Toggle } from './Toggle';

/**
 * SecuritySettings — the real, ENFORCED tenant security controls (ADR-046,
 * ADMIN-HIGH-010).
 *
 * Replaces the "not yet available" stub. Only the two controls auth-service
 * actually persists AND enforces are rendered:
 *   - enforceMfa — the login MFA-enrollment gate
 *   - sessionTimeoutMinutes — the idle-session timeout that clamps the
 *     refresh-token TTL at every mint
 *
 * IP whitelisting is deliberately NOT rendered as a control: it has no
 * persistence and no enforcement yet (tracked as ADMIN-MEDIUM-013), and an
 * unpersisted control is exactly the defect this screen was written to cure.
 */

interface SecuritySettingsProps {
  canEdit: boolean;
}

// Server bound (auth-service UpdateTenantSecurityPolicyInput, mirrored by the
// auth.tenants CHECK constraint): 5..1440 minutes.
const MIN_SESSION_TIMEOUT = 5;
const MAX_SESSION_TIMEOUT = 1440;

const SecuritySettings: React.FC<SecuritySettingsProps> = ({ canEdit }) => {
  const { data: policy, isLoading, isError } = useTenantSecurityPolicy();
  const updateMutation = useUpdateTenantSecurityPolicy();

  const [enforceMfa, setEnforceMfa] = useState(false);
  // Kept as a raw string so "unset" (platform default) stays representable.
  const [timeoutInput, setTimeoutInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (policy) {
      setEnforceMfa(policy.enforceMfa);
      setTimeoutInput(
        policy.sessionTimeoutMinutes != null ? String(policy.sessionTimeoutMinutes) : '',
      );
    }
  }, [policy]);

  // Client-side validation mirrors the server bound so the admin sees the
  // problem before a round trip. Empty = "use the platform default": the field
  // is omitted from the update and the stored value is left untouched.
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

  // Warn only when the admin is turning enforcement ON (it was off when loaded)
  // — that is the transition that signs factor-less users out.
  const mfaBeingEnabled = enforceMfa && policy?.enforceMfa === false;

  const handleSave = useCallback(async () => {
    if (timeoutError) return;
    setSaveError(null);
    const input: UpdateTenantSecurityPolicyInput = { enforceMfa };
    const raw = timeoutInput.trim();
    if (raw !== '') {
      input.sessionTimeoutMinutes = Number(raw);
    }
    try {
      await updateMutation.mutateAsync(input);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      logError('SecuritySettings.handleSave', err);
      setSaveError(sanitizeErrorMessage(err));
    }
  }, [enforceMfa, timeoutInput, timeoutError, updateMutation]);

  const saving = updateMutation.isPending;
  const inputClass =
    'w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed';

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading security settings...
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
      <div>
        <div className="flex items-center gap-2 mb-1 text-tenant-700">
          <ShieldCheck className="w-4 h-4" />
          <h3 className="text-sm font-semibold uppercase tracking-wider">Authentication</h3>
        </div>
        <div className="divide-y divide-gray-100">
          <Toggle
            enabled={enforceMfa}
            onChange={canEdit ? setEnforceMfa : () => undefined}
            label="Require MFA for all users"
            description="Every user of this tenant must have multi-factor authentication enrolled to sign in."
          />
        </div>
        {mfaBeingEnabled && (
          <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              Turning this on signs out every tenant user who does not yet have a second factor.
              They must set up MFA before they can sign in again.
            </span>
          </div>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="sessionTimeout">
          Session timeout (minutes)
          <span className="ml-2 text-xs font-normal text-gray-400">
            {MIN_SESSION_TIMEOUT}-{MAX_SESSION_TIMEOUT}; leave blank to use the platform default
          </span>
        </label>
        <input
          id="sessionTimeout"
          type="number"
          min={MIN_SESSION_TIMEOUT}
          max={MAX_SESSION_TIMEOUT}
          step={1}
          value={timeoutInput}
          onChange={(e) => setTimeoutInput(e.target.value)}
          placeholder="Platform default"
          aria-invalid={timeoutError !== null}
          disabled={!canEdit}
          className={inputClass}
        />
        {timeoutError && (
          <p className="mt-1 text-sm text-red-600 flex items-center gap-1">
            <AlertCircle className="w-4 h-4" />
            {timeoutError}
          </p>
        )}
        <p className="mt-1 text-xs text-gray-500">
          Idle sessions end after this many minutes without activity.
        </p>
      </div>

      {/* IP whitelisting has no persistence and no enforcement yet
          (ADMIN-MEDIUM-013) — stated as a note, never as a control. */}
      <div className="flex items-start gap-2 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-500">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          <strong>IP whitelisting</strong> is not configurable yet.
        </span>
      </div>

      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {saveError && (
            // A save failure must be ANNOUNCED, not just coloured red — this is
            // a policy write, and silently failing it is the defect class this
            // whole screen exists to remove.
            <p role="alert" className="text-xs text-red-600 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {saveError}
            </p>
          )}
          <button
            onClick={handleSave}
            disabled={saving || timeoutError !== null}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saved ? (
              <>
                <Check className="w-4 h-4" />
                Saved!
              </>
            ) : saving ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Changes
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default SecuritySettings;
