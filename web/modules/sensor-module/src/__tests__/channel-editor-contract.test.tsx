/**
 * SENSOR-HIGH-063 — the channel editor may only offer edits the contract can carry.
 *
 * The finding was that channel CRUD failed 100% of the time: the panel built its
 * payloads from field names `CreateDataChannelInput` / `UpdateDataChannelInput` have
 * never defined, and GraphQL rejects an input object carrying an undefined field.
 * Two of those names were sent unconditionally — `discoverySource: 'manual'` on
 * create and `dataType` on update — so the failure was total rather than occasional.
 *
 * The payload shape itself is held by two other things: the FE input interfaces are
 * asserted to be a subset of the backend DTO by
 * tests/invariants/sensor-graphql-fe-be-parity.spec.ts, and tsc's excess-property
 * check then stops a mapper returning anything the interface does not declare.
 *
 * What is left for a rendering test is the half a type cannot state: that the FORM
 * does not invite an edit which would be dropped on the way out. A disabled control
 * is the difference between "this cannot be changed" and "we ignored your change".
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('lucide-react', () => {
  const factory =
    (name: string) =>
    (props: Record<string, unknown>): React.ReactElement => (
      <span data-testid={`icon-${name}`} {...props} />
    );
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => (prop === '__esModule' ? true : factory(prop)),
    },
  );
});

import { ChannelEditorModal } from '../components/registration/ChannelEditorModal';
import { ChannelDataType, DataChannelConfig } from '../types/registration.types';

const SAVED_CHANNEL: DataChannelConfig = {
  id: 'channel-uuid-1',
  channelKey: 'temperature',
  displayLabel: 'Water temperature',
  dataType: ChannelDataType.NUMBER,
  unit: '°C',
  minValue: 0,
  maxValue: 40,
  calibrationEnabled: false,
  calibrationMultiplier: 1,
  calibrationOffset: 0,
  isEnabled: true,
  displayOrder: 0,
};

/** The key input keeps its placeholder when disabled; getByDisplayValue would not find a <select>. */
function fieldByPlaceholder(placeholder: string): HTMLInputElement {
  return screen.getByPlaceholderText(placeholder) as HTMLInputElement;
}

function dataTypeSelect(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: /data type/i }) as HTMLSelectElement;
}

function renderModal(channel?: DataChannelConfig): void {
  render(<ChannelEditorModal channel={channel} isOpen onClose={vi.fn()} onSave={vi.fn()} />);
}

describe('ChannelEditorModal — contract-shaped editing (SENSOR-HIGH-063)', () => {
  it('calls a channel with no id NEW, so the add dialog does not title itself Edit', () => {
    // `isNew` used to be `!channel?.id && !channel?.channelKey?.startsWith('channel_') === false`.
    // `!` binds tighter than `===`, so it meant "no id AND the key starts with channel_" —
    // and the Add button passes no channel at all, so it was false: the create dialog
    // announced "Edit Data Channel" above a "Save Changes" button.
    renderModal(undefined);

    expect(screen.getByText('Add Data Channel')).toBeTruthy();
    expect(screen.queryByText('Edit Data Channel')).toBeNull();
  });

  it('still calls a discovered placeholder channel new — it has no id either', () => {
    renderModal({ ...SAVED_CHANNEL, id: undefined, channelKey: 'channel_1' });

    expect(screen.getByText('Add Data Channel')).toBeTruthy();
  });

  it('lets a new channel choose its key and data type', () => {
    renderModal(undefined);

    expect(fieldByPlaceholder('e.g., temperature, ph_level').disabled).toBe(false);
    expect(dataTypeSelect().disabled).toBe(false);
  });

  it('freezes the key and data type once the channel is persisted', () => {
    // UpdateDataChannelInput carries neither. Before this, the form accepted both
    // edits and the save then failed outright on dataType — the user saw an error
    // for a field they were invited to change.
    renderModal(SAVED_CHANNEL);

    expect(fieldByPlaceholder('e.g., temperature, ph_level').disabled).toBe(true);
    expect(dataTypeSelect().disabled).toBe(true);
    expect(screen.getByText('Edit Data Channel')).toBeTruthy();
  });

  it('says why the frozen fields are frozen instead of just greying them out', () => {
    renderModal(SAVED_CHANNEL);

    expect(
      screen.getByText('Fixed after creation — stored readings are keyed by it.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Fixed after creation — stored readings were parsed as this type.'),
    ).toBeTruthy();
  });
});
