import {
  ConfigurationKeyId,
  ConfigurationSnapshotStateV1,
} from '@aquaculture/configuration-contracts';
import { Alert, Button, Card } from '@aquaculture/shared-ui';
import React, { useEffect, useMemo, useState } from 'react';

import { ADMIN_CONFIGURATION_UI } from '../generated/configuration-ui.generated';
import { usePlatformSettings, useSavePlatformSettings } from '../hooks/usePlatformConfiguration';
import {
  clearConfigurationChange,
  configurationEditorValues,
  setConfigurationChange,
} from '../services/api/platform-configuration';
import type {
  ConfigurationEditorValuesV1,
  ConfigurationSnapshotEntryV1,
} from '../services/api/platform-configuration';

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  general: 'General',
  security: 'Security',
  email: 'Email',
  rate_limit: 'Rate Limits',
  storage: 'Storage',
  maintenance: 'Maintenance',
  billing: 'Billing',
  feature_flag: 'Feature Flags',
};

const CATEGORIES = [...new Set(ADMIN_CONFIGURATION_UI.map((entry) => entry.category))];

function choices(validation: Readonly<Record<string, unknown>>): readonly string[] {
  const value = validation['choices'];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function requiredSnapshotEntry(
  entries: ReadonlyMap<ConfigurationKeyId, ConfigurationSnapshotEntryV1>,
  keyId: ConfigurationKeyId,
): ConfigurationSnapshotEntryV1 {
  const entry = entries.get(keyId);
  if (!entry) throw new Error(`Configuration snapshot lost catalog entry ${keyId}`);
  return entry;
}

const SystemSettingsPage: React.FC = () => {
  const { snapshot, isLoading, error: loadError, refetch } = usePlatformSettings();
  const save = useSavePlatformSettings();
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0] ?? 'general');
  const [values, setValues] = useState<ConfigurationEditorValuesV1 | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<ConfigurationKeyId>>(new Set());
  const [clear, setClear] = useState<ReadonlySet<ConfigurationKeyId>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const entries = useMemo(
    () => new Map(snapshot?.entries.map((entry) => [entry.keyId, entry]) ?? []),
    [snapshot],
  );

  useEffect(() => {
    if (!snapshot) return;
    try {
      setValues(configurationEditorValues(snapshot));
      setDirty(new Set());
      setClear(new Set());
      setError(null);
    } catch (cause) {
      setValues(null);
      setError(cause instanceof Error ? cause.message : 'Configuration projection failed');
    }
  }, [snapshot]);

  const descriptors = ADMIN_CONFIGURATION_UI.filter(
    (descriptor) => descriptor.category === activeCategory,
  ).sort((left, right) => left.order - right.order);

  const changeValue = (keyId: ConfigurationKeyId, value: string): void => {
    if (!values) return;
    setValues({ ...values, [keyId]: value });
    setDirty(new Set([...dirty, keyId]));
    const nextClear = new Set(clear);
    nextClear.delete(keyId);
    setClear(nextClear);
  };

  const markClear = (keyId: ConfigurationKeyId): void => {
    if (!values) return;
    setValues({ ...values, [keyId]: '' });
    setDirty(new Set([...dirty, keyId]));
    setClear(new Set([...clear, keyId]));
  };

  const saveCategory = async (): Promise<void> => {
    if (!snapshot || !values) return;
    setError(null);
    setSuccess(null);
    try {
      const categoryIds = new Set(descriptors.map((descriptor) => descriptor.id));
      const changedIds = [...dirty].filter((keyId) => categoryIds.has(keyId));
      if (changedIds.length === 0) return;
      const changes = changedIds.map((keyId) =>
        clear.has(keyId)
          ? clearConfigurationChange(keyId)
          : setConfigurationChange(keyId, values[keyId]),
      );
      await save.mutateAsync({
        expectedSnapshotToken: snapshot.snapshotToken,
        reason: `admin-panel ${activeCategory} configuration update`,
        changes,
      });
      setSuccess(`${CATEGORY_LABELS[activeCategory] ?? activeCategory} configuration saved`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Configuration save failed');
    }
  };

  if (isLoading && !snapshot) {
    return <div className="h-64 flex items-center justify-center">Loading configuration…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Configuration</h1>
          <p className="text-sm text-gray-500">
            Catalog-qualified, atomically versioned platform settings
          </p>
        </div>
        <Button variant="outline" onClick={refetch} disabled={isLoading}>
          Refresh
        </Button>
      </div>

      {loadError && <Alert type="error">{loadError.message}</Alert>}
      {error && <Alert type="error">{error}</Alert>}
      {success && <Alert type="success">{success}</Alert>}
      {snapshot?.readiness === 'RED' && (
        <Alert type="error">
          Configuration readiness is RED.
          {snapshot.missingRequiredKeys.length > 0 &&
            ` Missing required: ${snapshot.missingRequiredKeys.join(', ')}.`}
          {snapshot.invalidKeys.length > 0 &&
            ` Invalid persisted values: ${snapshot.invalidKeys.join(', ')}.`}
          {snapshot.catalogMismatches.length > 0 &&
            ` Unknown persisted catalog IDs: ${snapshot.catalogMismatches.join(', ')}.`}
        </Alert>
      )}

      <div className="border-b border-gray-200 overflow-x-auto">
        <nav className="flex gap-4">
          {CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => setActiveCategory(category)}
              className={`px-3 py-2 text-sm border-b-2 whitespace-nowrap ${
                category === activeCategory
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500'
              }`}
            >
              {CATEGORY_LABELS[category] ?? category}
            </button>
          ))}
        </nav>
      </div>

      <Card className="p-6 space-y-5">
        {values &&
          descriptors.map((descriptor) => {
            const entry = requiredSnapshotEntry(entries, descriptor.id);
            const value = values[descriptor.id];
            const options = choices(descriptor.validation);
            const disabled = !descriptor.mutable || save.isPending;
            return (
              <div key={descriptor.id} className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_2fr]">
                <div>
                  <label htmlFor={descriptor.id} className="font-medium text-sm text-gray-900">
                    {descriptor.label}
                  </label>
                  <p className="text-xs text-gray-500">{descriptor.description}</p>
                  <p className="text-xs text-gray-400">
                    {entry.state} · {entry.source}
                    {entry.fallbackSuppressed ? ' · fallback suppressed' : ''}
                    {descriptor.requiresRestart ? ' · restart required' : ''}
                  </p>
                </div>
                <div className="flex gap-2 items-center">
                  {descriptor.control === 'TOGGLE' ? (
                    <input
                      id={descriptor.id}
                      type="checkbox"
                      checked={value === 'true'}
                      disabled={disabled}
                      onChange={(event) => changeValue(descriptor.id, String(event.target.checked))}
                    />
                  ) : descriptor.control === 'SELECT' ? (
                    <select
                      id={descriptor.id}
                      value={value}
                      disabled={disabled}
                      onChange={(event) => changeValue(descriptor.id, event.target.value)}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    >
                      {options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={descriptor.id}
                      type={
                        descriptor.control === 'SECRET'
                          ? 'password'
                          : descriptor.control === 'NUMBER'
                            ? 'number'
                            : 'text'
                      }
                      value={value}
                      disabled={disabled}
                      placeholder={
                        entry.state === ConfigurationSnapshotStateV1.SECRET_SET
                          ? 'Stored secret — enter only to rotate'
                          : entry.state === ConfigurationSnapshotStateV1.OPTIONAL_ABSENT ||
                              entry.state === ConfigurationSnapshotStateV1.MISSING_REQUIRED
                            ? 'Unset'
                            : undefined
                      }
                      onChange={(event) => changeValue(descriptor.id, event.target.value)}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    />
                  )}
                  {!descriptor.required &&
                    (entry.state !== ConfigurationSnapshotStateV1.OPTIONAL_ABSENT ||
                      entry.fallbackSuppressed) && (
                      <Button
                        variant="outline"
                        onClick={() => markClear(descriptor.id)}
                        disabled={disabled}
                      >
                        Clear
                      </Button>
                    )}
                </div>
              </div>
            );
          })}
        <div className="flex justify-end border-t pt-4">
          <Button
            onClick={() => void saveCategory()}
            loading={save.isPending}
            disabled={
              !snapshot || !values || !descriptors.some((descriptor) => dirty.has(descriptor.id))
            }
          >
            Apply Atomic Batch
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default SystemSettingsPage;
