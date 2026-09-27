import React from 'react';
import { NumberInput, DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import type { TankDefinition } from '../../types/solution.types';

interface DynamicTankTableProps {
  tanks: TankDefinition[];
  onChange: (tanks: TankDefinition[]) => void;
}

const DynamicTankTable: React.FC<DynamicTankTableProps> = ({ tanks, onChange }) => {
  const handleFactorChange = (index: number, value: number) => {
    const updated = tanks.map((t, i) => (i === index ? { ...t, concentrationFactor: value } : t));
    onChange(updated);
  };

  type TankRow = (typeof tanks)[number];
  const tankRowColumns: DataTableColumn<TankRow>[] = [
    {
      key: 'tank',
      header: 'Tank',
      render: (_value, tank) => (
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300 text-sm font-bold">
          {tank.tankLabel}
        </span>
      ),
    },
    {
      key: 'concentrationFactor',
      header: 'Concentration Factor',
      render: (_value, tank, idx) => (
        <NumberInput
          value={tank.concentrationFactor}
          onChange={(e) => {
            const parsed = parseFloat(e.target.value);
            // WHY: Reject non-numeric input instead of silently coercing to 0.
            // A 0x concentration factor would zero out all stock solution
            // quantities, making the recipe unusable. The minimum valid
            // factor is 1 (no concentration).
            if (!Number.isFinite(parsed) || parsed < 1) return;
            handleFactorChange(idx, parsed);
          }}
          size="sm"
          min={1}
          max={200}
          unit="x"
          className="max-w-[160px]"
        />
      ),
    },
  ];

  return (
    <DataTable<TankRow>
      data={tanks}
      columns={tankRowColumns}
      keyExtractor={(tank) => tank.tankLabel}
      emptyMessage="No records found"
      searchable={false}
      sortable={false}
      stickyHeader={false}
    />
  );
};

export default DynamicTankTable;
