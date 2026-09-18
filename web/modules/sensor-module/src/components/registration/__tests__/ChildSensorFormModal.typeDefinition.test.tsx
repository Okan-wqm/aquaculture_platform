/**
 * SENSOR-MEDIUM-071: the live parent-child wizard can attach a custom
 * SensorTypeDefinition to a child. This pins the ChildSensorFormModal picker that
 * replaced the dead BasicInfoStep — selecting a custom type stores its id (which
 * the backend uses to bootstrap default channels) and mirrors the legacy enum.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Feed the modal a deterministic catalog instead of a network round-trip.
vi.mock('../../../hooks/useSensorTypeDefinitions', () => ({
  useSensorTypeDefinitions: () => ({
    types: [
      {
        id: 'td-ph',
        typeKey: 'ph',
        displayName: 'pH Probe',
        category: 'water',
        icon: null,
        isSystem: true,
      },
      {
        id: 'td-trout',
        typeKey: 'trout_multi',
        displayName: 'Trout Multi-Probe',
        category: 'aqua',
        icon: null,
        isSystem: false,
      },
    ],
    loading: false,
    error: null,
  }),
}));

import { ChildSensorFormModal } from '../ChildSensorFormModal';
import { SensorType } from '../../../types/registration.types';

// SENSOR-HIGH-117: dataPath is required in create mode — fill the mandatory
// fields so these legacy specs submit successfully under the new validation.
function fillMandatoryFields(): void {
  const name = screen.getByText('Data Name').parentElement?.querySelector('input');
  if (!name) throw new Error('Data Name input not found');
  fireEvent.change(name, { target: { value: 'Probe Parameter' } });
  const dataPath = screen.getByPlaceholderText('e.g. temperature, sensors.mid');
  fireEvent.change(dataPath, { target: { value: 'probe_value' } });
}

function selectCustomType(value: string): HTMLFormElement {
  // The custom-type <select> is the one carrying the "None …" sentinel option.
  const sentinel = screen.getByRole('option', {
    name: /None — use the data type above/,
  }) as HTMLOptionElement;
  const select = sentinel.closest('select');
  if (!select) throw new Error('custom-type select not found');
  fireEvent.change(select, { target: { value } });
  const form = select.closest('form');
  if (!form) throw new Error('form not found');
  return form;
}

describe('ChildSensorFormModal custom type-definition picker (SENSOR-MEDIUM-071)', () => {
  it('renders the picker when type definitions are available', () => {
    render(<ChildSensorFormModal isOpen onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText('Custom Type (optional)')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'pH Probe' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Trout Multi-Probe (custom)' })).toBeTruthy();
  });

  it('maps a system-type selection to its enum and stores the typeDefinitionId', () => {
    const onSave = vi.fn();
    render(<ChildSensorFormModal isOpen onClose={vi.fn()} onSave={onSave} />);

    const form = selectCustomType('td-ph');
    fillMandatoryFields();
    fireEvent.submit(form);

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved.typeDefinitionId).toBe('td-ph');
    // typeKey 'ph' resolves to the built-in enum (changed from the MULTI_PARAMETER default).
    expect(saved.type).toBe(SensorType.PH);
  });

  it('falls back to MULTI_PARAMETER when the custom typeKey has no built-in enum', () => {
    const onSave = vi.fn();
    render(<ChildSensorFormModal isOpen onClose={vi.fn()} onSave={onSave} />);

    const form = selectCustomType('td-trout');
    fillMandatoryFields();
    fireEvent.submit(form);

    const saved = onSave.mock.calls[0][0];
    expect(saved.typeDefinitionId).toBe('td-trout');
    expect(saved.type).toBe(SensorType.MULTI_PARAMETER);
  });
});
