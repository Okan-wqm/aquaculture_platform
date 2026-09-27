/**
 * ChartTooltipContent — the card a recharts Tooltip renders through `content`.
 *
 * FE-MEDIUM-081: seven recharts tooltips pinned `backgroundColor: 'white'` in a
 * `contentStyle`, so under the dark theme a white box with dark text floated
 * over every chart. The card paints from the theme in both palettes and keeps
 * recharts' contract: `active`, `label`, `payload`, `formatter` (a value or a
 * `[value, name]` pair) and `labelFormatter`.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChartTooltipContent } from '../ChartTooltip';

const payload = [
  { name: 'Biomass', value: 1250, color: '#10b981', dataKey: 'biomass', unit: ' kg' },
  { name: 'Feed', value: 80, color: '#f59e0b', dataKey: 'feed' },
];

describe('ChartTooltipContent', () => {
  it('renders nothing while inactive or without a payload', () => {
    const inactive = render(<ChartTooltipContent active={false} payload={payload} />);
    expect(inactive.container).toBeEmptyDOMElement();
    const empty = render(<ChartTooltipContent active payload={[]} />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it('lists the hovered series with their units under the label', () => {
    render(<ChartTooltipContent active label="Week 12" payload={payload} />);

    expect(screen.getByText('Week 12')).toBeInTheDocument();
    expect(screen.getByText('Biomass')).toBeInTheDocument();
    expect(screen.getByText('1250 kg')).toBeInTheDocument();
    expect(screen.getByText('Feed')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('applies recharts-style formatters for the value, the name and the label', () => {
    render(
      <ChartTooltipContent
        active
        label="12"
        payload={payload}
        formatter={(value, name) => [`${String(value)} t`, name.toUpperCase()]}
        labelFormatter={(label) => `Week ${String(label)}`}
      />,
    );

    expect(screen.getByText('Week 12')).toBeInTheDocument();
    expect(screen.getByText('BIOMASS')).toBeInTheDocument();
    expect(screen.getByText('1250 t kg')).toBeInTheDocument();
    expect(screen.getByText('FEED')).toBeInTheDocument();
  });

  it('paints from the theme in both palettes', () => {
    const { container } = render(<ChartTooltipContent active payload={payload} />);

    expect(container.firstElementChild).toHaveClass('bg-white', 'dark:bg-gray-900');
  });
});
