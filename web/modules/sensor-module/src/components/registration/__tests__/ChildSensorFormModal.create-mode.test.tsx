/**
 * SENSOR-HIGH-117: create mode for the child-parameter modal. The wizard's
 * discovery path (connection-test sample data) is unavailable whenever the
 * test cannot pass — e.g. an internal broker behind the SSRF guard — so the
 * modal must support entering a parameter from scratch: blank reset on open
 * (previously stale from the last edit), a required dataPath (the payload
 * key ingestion extracts), and inline duplicate rejection.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../../hooks/useSensorTypeDefinitions', () => ({
  useSensorTypeDefinitions: () => ({ types: [], loading: false, error: null }),
}));

import { ChildSensorFormModal } from '../ChildSensorFormModal';
import { SensorType } from '../../../types/registration.types';

const EXISTING_ROW = {
  dataPath: 'temperature',
  name: 'Temperature',
  type: SensorType.TEMPERATURE,
  selected: true,
  isConfigured: true,
  calibrationEnabled: false,
  calibrationMultiplier: 1,
  calibrationOffset: 0,
};

function openCreate(props: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  render(
    <ChildSensorFormModal
      isOpen
      onClose={() => undefined}
      onSave={onSave}
      existingDataPaths={['temperature', 'ph']}
      {...props}
    />,
  );
  return { onSave };
}

// The label and its input are siblings inside a wrapper div.
function getNamedInput(labelText: string | RegExp): HTMLInputElement {
  const label = screen.getByText(labelText);
  const wrapper = label.parentElement;
  const input = wrapper?.querySelector('input');
  if (!input) throw new Error(`input for label ${String(labelText)} not found`);
  return input as HTMLInputElement;
}

const { getByPlaceholderText } = screen;

function submitForm() {
  fireEvent.submit(
    screen.getByRole('button', { name: /save/i }).closest('form') as HTMLFormElement,
  );
}

describe('ChildSensorFormModal create mode (SENSOR-HIGH-117)', () => {
  it('opens blank in create mode even after an edit session', () => {
    const { rerender } = render(
      <ChildSensorFormModal
        isOpen
        sensor={EXISTING_ROW}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getAllByDisplayValue('Temperature').length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue('temperature').length).toBeGreaterThan(0);

    rerender(<ChildSensorFormModal isOpen onClose={() => undefined} onSave={() => undefined} />);
    expect(screen.getByText('Add Sensor Parameter')).toBeTruthy();
    expect(screen.queryAllByDisplayValue('Temperature')).toEqual([]);
    expect(screen.queryAllByDisplayValue('temperature')).toEqual([]);
  });

  it('blocks submit when the data path is empty', () => {
    const { onSave } = openCreate();
    fireEvent.change(getNamedInput('Data Name'), { target: { value: 'Sıcaklık' } });
    submitForm();

    expect(screen.getByRole('alert').textContent).toMatch(/data path is required/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('rejects a dataPath already used by another row', () => {
    const { onSave } = openCreate();
    fireEvent.change(getNamedInput('Data Name'), { target: { value: 'Dup' } });
    fireEvent.change(getByPlaceholderText('e.g. temperature, sensors.mid'), {
      target: { value: 'ph' },
    });
    submitForm();

    expect(screen.getByRole('alert').textContent).toMatch(/already uses the data path "ph"/);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves a valid manual parameter with the trimmed data path', () => {
    const { onSave } = openCreate();
    fireEvent.change(getNamedInput('Data Name'), { target: { value: 'Oksijen' } });
    fireEvent.change(getByPlaceholderText('e.g. temperature, sensors.mid'), {
      target: { value: ' dissolved_oxygen ' },
    });
    submitForm();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({
      name: 'Oksijen',
      dataPath: 'dissolved_oxygen',
      isConfigured: true,
    });
  });

  it('disables the data path input in edit mode (the key must not drift)', () => {
    render(
      <ChildSensorFormModal
        isOpen
        sensor={EXISTING_ROW}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(
      (getByPlaceholderText('e.g. temperature, sensors.mid') as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
