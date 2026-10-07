import { plainToInstance } from 'class-transformer';
import { getMetadataStorage, validate } from 'class-validator';

import * as layoutDtos from '../dto/dashboard-layout.dto';
import {
  CreateSystemDefaultLayoutInput,
  SaveDashboardLayoutInput,
  WidgetTimeRangesConstraint,
} from '../dto/dashboard-layout.dto';

function layout(widgets: unknown[]): SaveDashboardLayoutInput {
  return plainToInstance(SaveDashboardLayoutInput, { name: 'Overview', widgets });
}

async function widgetErrors(widgets: unknown[]): Promise<string[]> {
  const errors = await validate(layout(widgets));
  return errors
    .filter((error) => error.property === 'widgets')
    .flatMap((error) => Object.keys(error.constraints ?? {}));
}

/**
 * A dashboard widget stores the range it charts in a JSON column. The layout
 * input accepts only presets of the shared sensor-reading time range
 * (SENSOR-MEDIUM-152), so no stored widget can carry a range the browser
 * cannot resolve.
 */
describe('SaveDashboardLayoutInput widget time ranges', () => {
  it('accepts every widget range the dashboard offers', async () => {
    const widgets = ['live', '1h', '6h', '24h', '7d', '30d', '90d', '365d'].map((timeRange) => ({
      id: `w-${timeRange}`,
      timeRange,
    }));
    await expect(widgetErrors(widgets)).resolves.toEqual([]);
  });

  it('accepts a layout with no widgets', async () => {
    await expect(widgetErrors([])).resolves.toEqual([]);
  });

  it.each([
    ['an unknown preset', { id: 'w', timeRange: '4h' }],
    ['a SCADA token', { id: 'w', timeRange: 'last1h' }],
    ['a missing range', { id: 'w' }],
    ['a non-string range', { id: 'w', timeRange: 3_600_000 }],
    ['a non-object widget', 'w'],
  ])('rejects %s', async (_case, widget) => {
    await expect(widgetErrors([{ id: 'ok', timeRange: '24h' }, widget])).resolves.toEqual([
      'widgetTimeRanges',
    ]);
  });
});

describe('every layout input that writes widgets checks their ranges', () => {
  const inputClasses = Object.values(layoutDtos).filter(
    (value) => value !== WidgetTimeRangesConstraint,
  );

  it.each(inputClasses.map((input) => [input.name, input] as const))('%s', (_name, input) => {
    const metadata = getMetadataStorage().getTargetValidationMetadatas(input, '', true, false);
    const writesWidgets = metadata.some((entry) => entry.propertyName === 'widgets');
    const checksRanges = metadata.some(
      (entry) =>
        entry.propertyName === 'widgets' && entry.constraintCls === WidgetTimeRangesConstraint,
    );
    expect(checksRanges).toBe(writesWidgets);
  });

  it('rejects a system default layout with a range no chart resolves', async () => {
    const input = plainToInstance(CreateSystemDefaultLayoutInput, {
      name: 'Default',
      widgets: [{ id: 'w', timeRange: '12h' }],
    });
    const errors = await validate(input);
    expect(errors.map((error) => error.property)).toContain('widgets');
  });
});
