/**
 * ChartTooltipContent — the card a recharts Tooltip renders through `content`,
 * painted from the theme in both palettes (FE-MEDIUM-081, FE-MEDIUM-084).
 */
import React from 'react';

export interface ChartTooltipPayloadItem {
  name?: string | number;
  value?: number | string | ReadonlyArray<number | string>;
  color?: string;
  dataKey?: string | number;
  unit?: string;
}

export type ChartTooltipFormatter = (
  value: NonNullable<ChartTooltipPayloadItem['value']>,
  name: string,
  item: ChartTooltipPayloadItem,
) => React.ReactNode | [React.ReactNode, React.ReactNode];

export interface ChartTooltipContentProps {
  active?: boolean;
  label?: React.ReactNode;
  payload?: ReadonlyArray<ChartTooltipPayloadItem>;
  /** recharts' `formatter`: a value, or a `[value, name]` pair. */
  formatter?: ChartTooltipFormatter;
  labelFormatter?: (
    label: React.ReactNode,
    payload: ReadonlyArray<ChartTooltipPayloadItem>,
  ) => React.ReactNode;
  className?: string;
}

function splitFormatted(
  formatted: React.ReactNode | [React.ReactNode, React.ReactNode],
  fallbackName: string,
): [React.ReactNode, React.ReactNode] {
  if (Array.isArray(formatted) && formatted.length === 2) return [formatted[0], formatted[1]];
  return [formatted, fallbackName];
}

/**
 * The card a recharts `Tooltip` renders through `content={<ChartTooltipContent />}`:
 * recharts positions it and hands it the hovered payload, its `formatter` and
 * `labelFormatter`; the card paints from the theme in both palettes, where a
 * `contentStyle` pinned a white box under the dark theme (FE-MEDIUM-081).
 */
export const ChartTooltipContent: React.FC<ChartTooltipContentProps> = ({
  active,
  label,
  payload,
  formatter,
  labelFormatter,
  className = '',
}) => {
  if (!active || payload === undefined || payload.length === 0) return null;
  const hasLabel = label !== undefined && label !== null && label !== '';
  const heading = hasLabel ? (labelFormatter ? labelFormatter(label, payload) : label) : null;

  return (
    <div
      className={`rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-gray-700 dark:bg-gray-900 ${className}`}
    >
      {heading !== null && (
        <div className="mb-1 border-b border-gray-100 pb-1 font-medium text-gray-900 dark:border-gray-700 dark:text-gray-100">
          {heading}
        </div>
      )}
      <div className="space-y-1">
        {payload.map((item, index) => {
          const name = String(item.name ?? item.dataKey ?? '');
          const formatted =
            item.value !== undefined && formatter ? formatter(item.value, name, item) : item.value;
          const [value, shownName] = splitFormatted(formatted, name);
          return (
            <div key={`${name}-${index}`} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                {item.color !== undefined && (
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: item.color }}
                    aria-hidden="true"
                  />
                )}
                {shownName}
              </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {value}
                {item.unit ?? ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ChartTooltipContent;
