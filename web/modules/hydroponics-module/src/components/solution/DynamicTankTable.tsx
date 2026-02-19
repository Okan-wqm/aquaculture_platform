import React from 'react';
import { NumberInput } from '@aquaculture/shared-ui';
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

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
          <th className="pb-2 pr-4">Tank</th>
          <th className="pb-2">Concentration Factor</th>
        </tr>
      </thead>
      <tbody>
        {tanks.map((tank, idx) => (
          <tr key={tank.tankLabel} className="border-b border-gray-100 last:border-b-0">
            <td className="py-2 pr-4">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-green-50 text-green-700 text-sm font-bold">
                {tank.tankLabel}
              </span>
            </td>
            <td className="py-2">
              <NumberInput
                value={tank.concentrationFactor}
                onChange={(e) => handleFactorChange(idx, parseFloat(e.target.value) || 0)}
                size="sm"
                min={1}
                max={200}
                unit="x"
                className="max-w-[160px]"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export default DynamicTankTable;
