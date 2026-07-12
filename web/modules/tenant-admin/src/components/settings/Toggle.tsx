import React from 'react';
import { Switch } from '@aquaculture/shared-ui';

/**
 * Toggle switch component for settings pages.
 *
 * Thin wrapper over the shared-ui `Switch` (ADMIN-MEDIUM-004): keeps the
 * module-local `{ enabled, onChange(boolean), label, description }` API and
 * the label-left / switch-right settings-row layout; the switch itself comes
 * from shared-ui.
 */
export const Toggle: React.FC<{
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  label: string;
  description?: string;
}> = ({ enabled, onChange, label, description }) => (
  <div className="flex items-center justify-between py-4">
    <div>
      <p className="text-sm font-medium text-gray-900">{label}</p>
      {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
    </div>
    <Switch
      checked={enabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={label}
    />
  </div>
);

/**
 * Small inline toggle for table cells.
 */
export const SmallToggle: React.FC<{
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}> = ({ enabled, onChange }) => (
  <Switch
    size="sm"
    checked={enabled}
    onChange={(e) => onChange(e.target.checked)}
    className="justify-center"
  />
);
