/**
 * RadioGroup — `variant="card"`: one native radio per card, the whole card its click target.
 *
 * A rich choice (an AI agent with its face, job, tier and capabilities) needs more than a text
 * row, but it is still one radio: keyboard arrows, form semantics and the checked state stay the
 * platform's. The radio's name is the label (+ its suffix), never the whole card — the media and
 * the details are visual and hidden from assistive technology; the description is its
 * accessible description. The default list variant keeps its shape.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { RadioGroup, type RadioOption } from '../Checkbox';

const OPTIONS: RadioOption[] = [
  {
    value: 'a',
    label: 'Production Specialist',
    labelSuffix: 'Expert',
    description: 'Growth, feeding plans',
    media: <span role="img" aria-label="face" data-testid="face" />,
    details: <span>Batch performance</span>,
  },
  { value: 'b', label: 'Operations Assistant', description: 'Water quality' },
];

function Controlled({ variant }: { variant?: 'list' | 'card' }): React.ReactElement {
  const [value, setValue] = useState('b');
  return (
    <RadioGroup
      label="Assistants"
      name="persona"
      variant={variant}
      options={OPTIONS}
      value={value}
      onChange={setValue}
    />
  );
}

describe('RadioGroup variant="card"', () => {
  it('names each radio by its label and suffix, and describes it by its description', () => {
    render(<Controlled variant="card" />);

    const radio = screen.getByRole('radio', { name: 'Production Specialist Expert' });
    expect(radio).toHaveAccessibleDescription('Growth, feeding plans');
    expect(screen.getByRole('radio', { name: 'Operations Assistant' })).toBeChecked();
    expect(screen.getByRole('group', { name: 'Assistants' })).toContainElement(radio);
  });

  it('renders the media and the details inside the card, hidden from assistive technology', () => {
    render(<Controlled variant="card" />);

    const card = screen
      .getByRole('radio', { name: 'Production Specialist Expert' })
      .closest('label');
    expect(card).toContainElement(screen.getByTestId('face'));
    expect(card).toHaveTextContent('Batch performance');
    expect(screen.getByTestId('face').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText('Batch performance').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('keeps the name when an option value contains a space', () => {
    render(
      <RadioGroup
        variant="card"
        name="spaced"
        options={[{ value: 'new planting', label: 'New planting', description: 'Seedlings' }]}
      />,
    );

    expect(screen.getByRole('radio', { name: 'New planting' })).toHaveAccessibleDescription(
      'Seedlings',
    );
  });

  it('selects an option from anywhere on its card and marks the card selected', async () => {
    render(<Controlled variant="card" />);

    await userEvent.click(screen.getByText('Batch performance'));

    const radio = screen.getByRole('radio', { name: 'Production Specialist Expert' });
    expect(radio).toBeChecked();
    expect(radio.closest('label')).toHaveAttribute('data-selected', 'true');
  });

  it('moves the choice with the arrow keys like any radio group', async () => {
    render(<Controlled variant="card" />);

    screen.getByRole('radio', { name: 'Operations Assistant' }).focus();
    await userEvent.keyboard('{ArrowUp}');

    expect(screen.getByRole('radio', { name: 'Production Specialist Expert' })).toBeChecked();
  });
});

describe('RadioGroup default list variant', () => {
  it('keeps the text row: named by the label, described by the description', () => {
    render(<Controlled />);

    const radio = screen.getByRole('radio', { name: 'Operations Assistant' });
    expect(radio).toHaveAccessibleDescription('Water quality');
    expect(radio.closest('label')).toBeNull();
  });
});
