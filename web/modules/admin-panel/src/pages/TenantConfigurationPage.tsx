/**
 * Tenant Configuration Page
 *
 * One tenant's settings, read from and written to config-service.
 *
 * # What this replaced
 *
 * The previous version drove nine tabs through 39 admin-api REST routes whose
 * service was labelled, in its own source, a "legacy adapter". Every write threw
 * 410 Gone. Every read called `createDefaultTenantConfiguration(tenantId)` and
 * served the result as that tenant's stored configuration — the same numbers for
 * every tenant, out of a TypeScript constant, with an id of `legacy:<tenantId>`
 * and epoch timestamps. The page loaded, the fields were populated, and nothing
 * on it was true.
 *
 * # How this one cannot repeat it
 *
 * The fields are not written here at all. They are derived from
 * `TENANT_SETTINGS`, config-service's own vocabulary, generated into this
 * module's tree — the same array that seeds the SYSTEM-tenant default rows. A
 * setting the store does not define cannot be rendered, and a setting the store
 * defines cannot be forgotten by the page. Adding one is a vocabulary entry and
 * nothing else.
 *
 * Each field also says where its value came from: `Default` when the seeded
 * SYSTEM row answered, nothing when this tenant decided it. That distinction is
 * the one the old page could not draw, because it invented both sides of it.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Badge, Button, Card, Input } from '@aquaculture/shared-ui';

import {
  useSaveTenantSettings,
  useTenantSettings,
} from '../hooks/useTenantConfiguration';
import {
  TENANT_SETTING_SECTIONS,
  draftWrite,
  isDraftValid,
  sectionKeys,
  sectionLabel,
  settingDefinition,
  settingLabel,
} from '../services/api/tenant-configuration';
import type {
  TenantSettingKey,
  TenantSettingSection,
  TenantSettingWrite,
  TenantSettingsReader,
} from '../services/api/tenant-configuration';

// ============================================================================
// Feedback banner
// ============================================================================

const AlertBanner: React.FC<{
  type: 'success' | 'error';
  message: string;
  onDismiss: () => void;
}> = ({ type, message, onDismiss }) => {
  const tone =
    type === 'success'
      ? { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700' }
      : { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700' };

  return (
    <div
      className={`${tone.bg} border ${tone.border} rounded-lg p-3 flex items-center justify-between`}
      role="status"
    >
      <span className={`${tone.text} text-sm`}>{message}</span>
      <button onClick={onDismiss} className="ml-4 text-gray-400 hover:text-gray-600" type="button">
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
};

// ============================================================================
// List editor — the `json` value type, edited as its members
// ============================================================================

const ListField: React.FC<{
  value: readonly string[];
  placeholder: string;
  onChange: (next: readonly string[]) => void;
}> = ({ value, placeholder, onChange }) => {
  const [entry, setEntry] = useState('');

  const add = (): void => {
    const trimmed = entry.trim();
    if (trimmed === '' || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setEntry('');
  };

  return (
    <div>
      <div className="flex space-x-2 mb-2">
        <Input
          type="text"
          value={entry}
          placeholder={placeholder}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button variant="secondary" size="sm" onClick={add} type="button">
          Add
        </Button>
      </div>
      {value.length === 0 ? (
        <p className="text-sm text-gray-400 italic">Empty.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {value.map((member) => (
            <span
              key={member}
              className="inline-flex items-center bg-gray-100 rounded px-2 py-1 text-sm font-mono text-gray-700"
            >
              {member}
              <button
                type="button"
                className="ml-2 text-gray-400 hover:text-red-600"
                onClick={() => onChange(value.filter((item) => item !== member))}
                aria-label={`Remove ${member}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// One setting, rendered by its declared value type
// ============================================================================

const SettingField: React.FC<{
  settingKey: TenantSettingKey;
  canonical: string;
  isDefault: boolean;
  onChange: (canonical: string) => void;
}> = ({ settingKey, canonical, isDefault, onChange }) => {
  const definition = settingDefinition(settingKey);
  const invalid = !isDraftValid(settingKey, canonical);

  return (
    <div className="py-4 border-b border-gray-100 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label className="block text-sm font-medium text-gray-900" htmlFor={settingKey}>
            {settingLabel(settingKey)}
          </label>
          <p className="text-xs text-gray-500 mt-0.5">{definition.description}</p>
          <code className="text-[11px] text-gray-400 font-mono">{settingKey}</code>
        </div>
        {/* Says which partition answered. Nothing is shown for a value this
            tenant decided — the badge marks the absence of a decision, which is
            the fact the retired page could not report. */}
        {isDefault && (
          <Badge variant="outline" size="sm">
            Default
          </Badge>
        )}
      </div>

      <div className="mt-3 max-w-lg">
        {definition.valueType === 'boolean' && (
          <label className="flex items-center">
            <input
              id={settingKey}
              type="checkbox"
              className="h-4 w-4 text-blue-600 rounded"
              checked={canonical === 'true'}
              onChange={(event) => onChange(String(event.target.checked))}
            />
            <span className="ml-2 text-sm text-gray-700">
              {canonical === 'true' ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        )}

        {definition.valueType === 'number' && (
          <Input
            id={settingKey}
            type="number"
            value={canonical}
            onChange={(event) => onChange(event.target.value)}
          />
        )}

        {definition.valueType === 'string' && (
          <Input
            id={settingKey}
            type="text"
            value={canonical}
            onChange={(event) => onChange(event.target.value)}
          />
        )}

        {definition.valueType === 'json' && (
          <ListField
            value={parseList(canonical)}
            placeholder="Add an entry"
            onChange={(next) => onChange(JSON.stringify(next))}
          />
        )}

        {invalid && (
          <p className="text-xs text-red-600 mt-1">
            A value is required before this section can be saved.
          </p>
        )}
      </div>
    </div>
  );
};

/**
 * The members of a canonical `json` draft.
 *
 * A draft is only ever produced by `canonical()` or by this component's own
 * `JSON.stringify`, so malformed text means the draft is mid-edit; an empty
 * list keeps the editor usable until it is well-formed again.
 */
function parseList(canonical: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(canonical);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

// ============================================================================
// Page
// ============================================================================

const TenantConfigurationPage: React.FC = () => {
  const { tenantId } = useParams<{ tenantId: string }>();
  const resolvedTenantId = tenantId ?? '';

  const [activeSection, setActiveSection] = useState<TenantSettingSection>(
    TENANT_SETTING_SECTIONS[0] ?? 'userLimits',
  );
  const [drafts, setDrafts] = useState<ReadonlyMap<TenantSettingKey, string>>(new Map());
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  const { settings, isLoading, error, refetch } = useTenantSettings(resolvedTenantId);
  const save = useSaveTenantSettings(resolvedTenantId);

  const valueOf = useCallback(
    (reader: TenantSettingsReader, key: TenantSettingKey): string =>
      drafts.get(key) ?? reader.canonical(key),
    [drafts],
  );

  const setDraft = useCallback((key: TenantSettingKey, canonical: string): void => {
    setDrafts((current) => new Map(current).set(key, canonical));
  }, []);

  const activeKeys = useMemo(() => sectionKeys(activeSection), [activeSection]);

  const pendingWrites = useMemo((): readonly TenantSettingWrite[] => {
    if (!settings) return [];
    return activeKeys
      .filter((key) => {
        const draft = drafts.get(key);
        return draft !== undefined && draft !== settings.canonical(key);
      })
      .map((key) => draftWrite(key, drafts.get(key) ?? ''));
  }, [activeKeys, drafts, settings]);

  const hasInvalidDraft = pendingWrites.some((write) => !isDraftValid(write.key, write.value));

  const handleSave = useCallback(async (): Promise<void> => {
    if (pendingWrites.length === 0) return;
    setFeedback(null);
    try {
      await save.mutateAsync(pendingWrites);
      // Drop the saved drafts so the fields fall back to the refetched rows —
      // and so `source` flips from Default to a decision without a reload.
      setDrafts((current) => {
        const next = new Map(current);
        for (const write of pendingWrites) next.delete(write.key);
        return next;
      });
      setFeedback({
        type: 'success',
        message: `Saved ${pendingWrites.length} setting${pendingWrites.length === 1 ? '' : 's'}.`,
      });
    } catch (saveError) {
      setFeedback({
        type: 'error',
        message: saveError instanceof Error ? saveError.message : 'Save failed.',
      });
    }
  }, [pendingWrites, save]);

  if (resolvedTenantId === '') {
    return (
      <Card>
        <p className="text-sm text-gray-600">No tenant selected.</p>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <p className="text-sm text-gray-500">Loading tenant settings…</p>
      </Card>
    );
  }

  if (error || !settings) {
    // A failed load renders as a failure, not as an empty form. The retired page
    // left a spinner running behind a dismissible banner, so a tenant whose
    // settings could not be read looked indistinguishable from one still loading.
    return (
      <Card>
        <p className="text-sm text-red-700 mb-3">
          {error ? error.message : 'Tenant settings could not be loaded.'}
        </p>
        <Button variant="secondary" onClick={refetch}>
          Retry
        </Button>
      </Card>
    );
  }

  const overridden = settings.overriddenKeys();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenant Configuration</h1>
          <p className="text-sm text-gray-500 mt-1">
            {overridden.length === 0
              ? 'Every setting is the platform default.'
              : `${overridden.length} of ${TENANT_SETTING_SECTIONS.reduce(
                  (total, section) => total + sectionKeys(section).length,
                  0,
                )} settings are set for this tenant.`}
          </p>
        </div>
        <code className="text-xs text-gray-400 font-mono">{resolvedTenantId}</code>
      </div>

      {feedback && (
        <AlertBanner
          type={feedback.type}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
      )}

      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-6 overflow-x-auto" aria-label="Settings sections">
          {TENANT_SETTING_SECTIONS.map((section) => (
            <button
              key={section}
              type="button"
              onClick={() => setActiveSection(section)}
              className={`whitespace-nowrap py-3 px-1 border-b-2 text-sm font-medium ${
                section === activeSection
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {sectionLabel(section)}
            </button>
          ))}
        </nav>
      </div>

      <Card title={sectionLabel(activeSection)}>
        <div>
          {activeKeys.map((key) => (
            <SettingField
              key={key}
              settingKey={key}
              canonical={valueOf(settings, key)}
              isDefault={drafts.has(key) ? false : settings.isDefault(key)}
              onChange={(canonical) => setDraft(key, canonical)}
            />
          ))}
        </div>

        <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-200 mt-4">
          {hasInvalidDraft && (
            <span className="text-sm text-red-600">Fix the highlighted field to save.</span>
          )}
          <Button
            variant="primary"
            onClick={() => {
              void handleSave();
            }}
            loading={save.isPending}
            disabled={pendingWrites.length === 0 || hasInvalidDraft}
          >
            {pendingWrites.length === 0
              ? 'No changes'
              : `Save ${pendingWrites.length} change${pendingWrites.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default TenantConfigurationPage;
