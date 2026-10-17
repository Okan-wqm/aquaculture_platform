/**
 * PID simulator — Industry console fit.
 *
 * Inside the tenant console the scope (shared-ui suderra.css) re-maps the
 * gray / primary / success / info / warning / error scales to the Industry
 * palette, so a class painted from them follows the theme and the dark mode
 * by itself. Two things on this page escaped it: the pump bars painted inline
 * colours from the theme.ts mirror (the legacy palette — a green BASE bar, a
 * blue DILUTE bar, light tints in the dark theme), and the nutrient pump, the
 * EC state and the EC+ disturbance painted from the `accent-*` scale. Accent
 * is the design system's High alarm tier and paints the hazard amber inside
 * the console; README §7.8 keeps red and amber for alarm and risk, and dosing
 * nutrient is normal operation. The nutrient category therefore paints from
 * primary, the workspace accent, on every surface that shows it: the pump
 * bar, the usage row, the EC+ button and the EC controller state.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ControlPanel from '../ControlPanel';
import PumpBars from '../PumpBars';
import StateIndicator from '../StateIndicator';
import { DEFAULT_SIM_CONFIG, type SimState, type SimStateName } from '../../simulation/types';

/** The design system's High alarm tier — amber in the console, coral outside it. */
const ACCENT = /\baccent-\d/;
/** The two alarm scales README §7.8 reserves for alarm and risk. */
const ALARM_SCALE = /\b(?:warning|error|accent)-\d/;

/** The element's parent; a rendered row always has one. */
function parentOf(el: Element): HTMLElement {
  const parent = el.parentElement;
  if (parent === null) throw new Error('element has no parent');
  return parent;
}

/** A meter's fill: the one bar inside its track. */
function fillOf(meter: HTMLElement): Element {
  const fill = meter.firstElementChild;
  if (fill === null) throw new Error('meter has no fill');
  return fill;
}

function simState(overrides: Partial<SimState> = {}): SimState {
  return {
    tick: 0,
    DIC: 2,
    ALK: 1,
    pH: 6,
    EC: 1.8,
    co2: 5,
    acidPump: 0,
    basePump: 0,
    nutPump: 0,
    dilPump: 0,
    state: 'IDLE',
    stateTimer: 0,
    alarmLatched: false,
    phPID: { integral: 0, prevError: 0, prevPV: 6, prevDerivative: 0, output: 0 },
    phHistory: [],
    ecHistory: [],
    hourlyResetTick: 0,
    acidTotalGrams: 0,
    baseTotalGrams: 0,
    nutTotalML: 0,
    co2Eq: 0.6,
    eqPH: 6.2,
    gainSchedule: 1,
    bufferCapacity: 1,
    ...overrides,
  };
}

describe('PumpBars', () => {
  it('paints every pump from the scoped scales, never an inline colour', () => {
    const { container } = render(
      <PumpBars acidPump={40} basePump={0} nutPump={12} dilPump={100} />,
    );

    for (const el of container.querySelectorAll<HTMLElement>('[style]')) {
      expect(el.style.backgroundColor).toBe('');
    }
    const meters = screen.getAllByRole('meter');
    expect(meters).toHaveLength(4);
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual([
      'ACID',
      'BASE',
      'NUTRIENT',
      'DILUTE',
    ]);
    expect(meters[0]).toHaveAttribute('aria-valuenow', '40');
    expect(fillOf(meters[0])).toHaveClass('bg-error-500');
  });

  it('paints the nutrient pump from the workspace accent, not an alarm scale', () => {
    render(<PumpBars acidPump={0} basePump={0} nutPump={12} dilPump={0} />);

    const nutrient = screen.getByRole('meter', { name: 'NUTRIENT' });
    expect(nutrient.className).not.toMatch(ALARM_SCALE);
    expect(fillOf(nutrient).className).not.toMatch(ALARM_SCALE);
    expect(fillOf(nutrient)).toHaveClass('bg-primary-600');
  });

  it('announces the reading the label shows, not the raw simulation fraction', () => {
    render(<PumpBars acidPump={37.84213} basePump={0} nutPump={0} dilPump={0} />);

    const acid = screen.getByRole('meter', { name: 'ACID' });
    expect(acid).toHaveAttribute('aria-valuetext', '37.8%');
    expect(screen.getByText('37.8%')).toBeInTheDocument();
  });

  it('gives every track a dark-theme counterpart', () => {
    render(<PumpBars acidPump={0} basePump={0} nutPump={0} dilPump={0} />);

    for (const meter of screen.getAllByRole('meter')) {
      expect(meter.className).toMatch(/\bdark:bg-/);
    }
  });
});

describe('StateIndicator', () => {
  const states: SimStateName[] = [
    'IDLE',
    'EC',
    'EC_WAIT',
    'CHEM_DT',
    'PH',
    'PH_WAIT',
    'DILUTE',
    'ALARM',
  ];
  const labelOf = (state: SimStateName): string =>
    state === 'PH' ? 'pH' : state === 'PH_WAIT' ? 'pH WAIT' : state.replace('_', ' ');

  it.each(states)('paints the %s chip from a scale other than accent', (state) => {
    render(<StateIndicator currentState={state} />);

    for (const chip of screen.getAllByRole('listitem')) {
      expect(chip.className).not.toMatch(ACCENT);
    }
  });

  it.each(states)('marks %s as the current step by more than its fill', (state) => {
    render(<StateIndicator currentState={state} />);

    const list = screen.getByRole('list', { name: 'Controller' });
    const current = within(list)
      .getAllByRole('listitem')
      .filter((chip) => chip.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(labelOf(state));
    // WCAG 1.4.1: the lit chip also carries an outline the idle chips lack.
    expect(current[0]).toHaveClass('outline-2');
    for (const chip of within(list).getAllByRole('listitem')) {
      if (chip !== current[0]) expect(chip).not.toHaveClass('outline-2');
    }
  });

  it('paints the EC (nutrient dosing) chip from the workspace accent, idle and lit', () => {
    const { rerender } = render(<StateIndicator currentState="IDLE" />);
    const idle = screen.getByText('EC', { selector: 'li' });
    expect(idle.className).not.toMatch(ALARM_SCALE);
    expect(idle).toHaveClass('bg-primary-100', 'text-primary-600');

    rerender(<StateIndicator currentState="EC" />);
    const lit = screen.getByText('EC', { selector: 'li' });
    expect(lit.className).not.toMatch(ALARM_SCALE);
    expect(lit).toHaveClass('bg-primary-600', 'text-white');
  });

  // An amber fill takes the dark ink (README §7.5 "HIGH amber with #1d1f20
  // text"); cream on the hazard amber is under 3:1.
  it.each(['EC_WAIT', 'CHEM_DT'] as const)(
    'writes the active %s chip in dark ink on the amber fill',
    (state) => {
      render(<StateIndicator currentState={state} />);
      const chip = screen.getByText(labelOf(state), { selector: 'li' });

      expect(chip).toHaveClass('bg-warning-400', 'text-gray-900');
      expect(chip).not.toHaveClass('text-white');
    },
  );

  // 12px semibold needs 4.5:1: amber-600 on amber-100 is 4.48:1 in the
  // console, amber-700 is 6.1:1.
  it.each(['EC_WAIT', 'CHEM_DT'] as const)(
    'writes the idle %s chip in the 700 amber ink',
    (state) => {
      render(<StateIndicator currentState="IDLE" />);
      const chip = screen.getByText(labelOf(state), { selector: 'li' });

      expect(chip).toHaveClass('bg-warning-100', 'text-warning-700');
      expect(chip).not.toHaveClass('text-warning-600');
    },
  );

  it('fills the active alarm chip with the deep hazard red', () => {
    render(<StateIndicator currentState="ALARM" />);

    expect(screen.getByText('ALARM', { selector: 'li' })).toHaveClass('bg-error-600', 'text-white');
  });
});

describe('ControlPanel', () => {
  function renderPanel(running = true): HTMLElement {
    const { container } = render(
      <ControlPanel
        state={simState({ nutTotalML: 120 })}
        config={{ ...DEFAULT_SIM_CONFIG, speedMultiplier: 5 }}
        running={running}
        onConfigChange={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onReset={vi.fn()}
        onDisturbance={vi.fn()}
      />,
    );
    return container;
  }

  it('paints nothing from the accent scale', () => {
    const container = renderPanel();

    for (const el of container.querySelectorAll<HTMLElement>('[class]')) {
      expect(el.getAttribute('class')).not.toMatch(ACCENT);
    }
  });

  it('shows the nutrient usage and the EC+ disturbance in the workspace accent', () => {
    renderPanel();

    const nutrientRow = parentOf(screen.getByText('Nutrient'));
    expect(nutrientRow).toHaveClass('bg-primary-50');
    for (const el of [nutrientRow, ...Array.from(nutrientRow.children)]) {
      expect(el.className).not.toMatch(ALARM_SCALE);
    }

    const ecUp = screen.getByRole('button', { name: 'EC +0.3' });
    expect(ecUp).toHaveClass('bg-primary-50', 'text-primary-700');
    expect(ecUp.className).not.toMatch(ALARM_SCALE);
  });

  it('marks the selected speed and the sliders in the workspace accent', () => {
    const container = renderPanel();

    const selected = within(container).getByRole('button', { name: '5x' });
    expect(selected).toHaveClass('bg-primary-600');
    for (const slider of container.querySelectorAll('input[type="range"]')) {
      expect(slider).toHaveClass('accent-primary-600');
    }
  });
});
