import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Save, Check, RefreshCw, AlertCircle, KeyRound, Sparkles } from 'lucide-react';
import {
  useAiProviderSettings,
  useUpdateAiProviderSettings,
  type LlmProviderId,
  type UpdateAiProviderSettingsInput,
} from '../../hooks/useAiProviderSettings';
import { logError, sanitizeErrorMessage } from '../../utils/error-handling';

interface AiAssistantSettingsProps {
  /** ai_settings:manage — false makes the whole surface read-only. */
  canEdit: boolean;
}

const PROVIDER_LABEL: Record<LlmProviderId, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
};

/**
 * Tenant AI (BYOK) provider settings section.
 *
 * The tenant brings its own provider API key; it is stored encrypted and never
 * shown again (only a ••••last4 hint). A newly-entered key is validated live
 * against the provider before it persists, so a dead key can't be saved
 * silently. Leaving a key field blank keeps the stored key unchanged.
 */
const AiAssistantSettings: React.FC<AiAssistantSettingsProps> = ({ canEdit }) => {
  const { data: settings, isLoading, isError } = useAiProviderSettings();
  const updateMutation = useUpdateAiProviderSettings();

  const [provider, setProvider] = useState<LlmProviderId>('anthropic');
  const [isEnabled, setIsEnabled] = useState(false);
  const [chatModel, setChatModel] = useState('');
  const [monthlyTokenBudget, setMonthlyTokenBudget] = useState(0);
  const [hourlyRequestLimit, setHourlyRequestLimit] = useState(0);
  // Key fields start empty — a blank field leaves the stored key untouched.
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setProvider(settings.provider);
      setIsEnabled(settings.isEnabled);
      setChatModel(settings.chatModel ?? '');
      setMonthlyTokenBudget(settings.monthlyTokenBudget);
      setHourlyRequestLimit(settings.hourlyRequestLimit);
    }
  }, [settings]);

  const availableProviders = useMemo<LlmProviderId[]>(
    () => (settings?.availableProviders?.length ? settings.availableProviders : ['anthropic']),
    [settings],
  );

  const handleSave = useCallback(async () => {
    setSaveError(null);
    // Send only what changed; omit untouched key fields so the stored key stays.
    const input: UpdateAiProviderSettingsInput = {
      provider,
      isEnabled,
      chatModel,
      monthlyTokenBudget,
      hourlyRequestLimit,
    };
    if (anthropicApiKey.trim()) input.anthropicApiKey = anthropicApiKey.trim();
    if (openaiApiKey.trim()) input.openaiApiKey = openaiApiKey.trim();
    try {
      await updateMutation.mutateAsync(input);
      // Clear the key inputs so a masked hint is never re-submitted.
      setAnthropicApiKey('');
      setOpenaiApiKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      logError('AiAssistantSettings.handleSave', err);
      setSaveError(sanitizeErrorMessage(err));
    }
  }, [
    provider,
    isEnabled,
    chatModel,
    monthlyTokenBudget,
    hourlyRequestLimit,
    anthropicApiKey,
    openaiApiKey,
    updateMutation,
  ]);

  const saving = updateMutation.isPending;
  const inputClass =
    'w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed';

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading AI settings…
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-red-600 flex items-center gap-1">
        <AlertCircle className="w-4 h-4" />
        Could not load AI settings.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Enablement banner — steers the admin to add a key when missing. */}
      {settings?.enablementReason === 'key_missing' && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          <KeyRound className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            AI is not active yet — add a valid {PROVIDER_LABEL[provider]} API key below to turn on
            the assistant for your team.
          </span>
        </div>
      )}
      {settings?.enablementReason === 'ok' && settings.isEnabled && (
        <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
          <Sparkles className="w-4 h-4 shrink-0" />
          AI assistant is active for this tenant.
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">AI Provider</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as LlmProviderId)}
          disabled={!canEdit}
          className={inputClass}
        >
          {availableProviders.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABEL[p]}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-3 text-sm font-medium text-gray-700">
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={(e) => setIsEnabled(e.target.checked)}
          disabled={!canEdit}
          className="h-4 w-4 rounded border-gray-300 text-tenant-600 focus:ring-tenant-500 disabled:cursor-not-allowed"
        />
        Enable the AI assistant
      </label>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Anthropic API Key
          {settings?.anthropicKeyHint && (
            <span className="ml-2 text-xs font-normal text-gray-400">
              current: {settings.anthropicKeyHint}
            </span>
          )}
        </label>
        <input
          type="password"
          autoComplete="off"
          value={anthropicApiKey}
          onChange={(e) => setAnthropicApiKey(e.target.value)}
          disabled={!canEdit}
          placeholder={settings?.anthropicKeyHint ? 'Enter a new key to replace' : 'sk-ant-…'}
          className={inputClass}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          OpenAI API Key
          {settings?.openaiKeyHint && (
            <span className="ml-2 text-xs font-normal text-gray-400">
              current: {settings.openaiKeyHint}
            </span>
          )}
        </label>
        <input
          type="password"
          autoComplete="off"
          value={openaiApiKey}
          onChange={(e) => setOpenaiApiKey(e.target.value)}
          disabled={!canEdit}
          placeholder={settings?.openaiKeyHint ? 'Enter a new key to replace' : 'sk-…'}
          className={inputClass}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Chat Model <span className="text-xs font-normal text-gray-400">(optional override)</span>
        </label>
        <input
          type="text"
          value={chatModel}
          onChange={(e) => setChatModel(e.target.value)}
          disabled={!canEdit}
          placeholder="Leave blank for the recommended default"
          className={inputClass}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Monthly Token Budget
          </label>
          <input
            type="number"
            min={0}
            value={monthlyTokenBudget}
            onChange={(e) => setMonthlyTokenBudget(Number(e.target.value))}
            disabled={!canEdit}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Hourly Request Limit
          </label>
          <input
            type="number"
            min={1}
            value={hourlyRequestLimit}
            onChange={(e) => setHourlyRequestLimit(Number(e.target.value))}
            disabled={!canEdit}
            className={inputClass}
          />
        </div>
      </div>

      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {saveError && (
            <p className="text-xs text-red-600 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {saveError}
            </p>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
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
      )}
    </div>
  );
};

export default AiAssistantSettings;
