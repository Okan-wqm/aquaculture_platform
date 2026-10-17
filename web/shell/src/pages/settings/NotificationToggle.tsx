/**
 * NotificationToggle — one switch row of the settings page's notification
 * card (Preferences tab): a label, its description, and the switch.
 *
 * WHY its own module: declared inside PreferencesTab's render, it was a new
 * component type on every render of the tab — and every toggle re-renders the
 * tab — so React replaced the button and keyboard focus fell to <body> after
 * each Space or Enter. At module scope the switch stays mounted.
 *
 * WHAT it announces: shared-ui's Switch, label first and the track at the
 * row's far edge — a switch (`role="switch"`, `aria-checked`) named by the
 * visible label beside it and described by the line under it, one control
 * and one tab stop. "On" is a selection, drawn in the workspace accent like
 * every selected control in the console; focus shows the accent ring for
 * keyboard focus only.
 */
import { Switch } from '@aquaculture/shared-ui';
import React from 'react';

export interface NotificationToggleProps {
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => void;
  readonly label: string;
  readonly desc: string;
}

export function NotificationToggle({
  enabled,
  onChange,
  label,
  desc,
}: NotificationToggleProps): React.ReactElement {
  return (
    <Switch
      labelPlacement="start"
      className="py-3"
      label={label}
      description={desc}
      checked={enabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
