/**
 * SENSOR-HIGH-117: the step must offer manual parameter entry when the
 * discovery path produced nothing (connection test could not pass — e.g.
 * internal broker behind the SSRF guard). Previously an empty list rendered
 * only the "no sensors selected" warning and the wizard could not advance.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ChildSensorsStep } from '../ChildSensorsStep';
import { SensorType } from '../../../../types/registration.types';

const DISCOVERED_ROW = {
  dataPath: 'temperature',
  name: 'Temperature',
  type: SensorType.TEMPERATURE,
  selected: true,
  isConfigured: true,
};

describe('ChildSensorsStep manual add (SENSOR-HIGH-117)', () => {
  it('renders the Add Parameter button with manual-entry copy when the list is empty', () => {
    render(
      <ChildSensorsStep
        childSensors={[]}
        onChange={() => undefined}
        onEditSensor={() => undefined}
        onAddSensor={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: '+ Add Parameter' })).toBeTruthy();
    expect(screen.getByText(/Add the parameters your device publishes manually/i)).toBeTruthy();
    expect(screen.queryByText(/The connection test found/i)).toBeNull();
  });

  it('keeps the discovery copy and Select All when rows exist', () => {
    render(
      <ChildSensorsStep
        childSensors={[DISCOVERED_ROW]}
        onChange={() => undefined}
        onEditSensor={() => undefined}
        onAddSensor={() => undefined}
      />,
    );

    expect(screen.getByText(/The connection test found 1 data value/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Deselect All|Select All/ })).toBeTruthy();
  });

  it('invokes onAddSensor when the button is clicked', () => {
    const onAddSensor = vi.fn();
    render(
      <ChildSensorsStep
        childSensors={[]}
        onChange={() => undefined}
        onEditSensor={() => undefined}
        onAddSensor={onAddSensor}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '+ Add Parameter' }));
    expect(onAddSensor).toHaveBeenCalledTimes(1);
  });
});
