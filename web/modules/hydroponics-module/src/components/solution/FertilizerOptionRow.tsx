import React from 'react';
import { Select, NumberInput } from '@aquaculture/shared-ui';
import type { SelectOption } from '@aquaculture/shared-ui';

interface FertilizerOptionRowProps {
  label: string;
  fertilizerOptions: SelectOption[];
  selectedFertilizer: string;
  onFertilizerChange: (value: string) => void;
  purityPercent: number;
  onPurityChange: (value: number) => void;
}

const FertilizerOptionRow: React.FC<FertilizerOptionRowProps> = ({
  label,
  fertilizerOptions,
  selectedFertilizer,
  onFertilizerChange,
  purityPercent,
  onPurityChange,
}) => {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-sm text-gray-700 w-28 shrink-0">{label}</span>
      <div className="flex-1 max-w-[240px]">
        <Select
          options={fertilizerOptions}
          value={selectedFertilizer}
          onChange={(e) => onFertilizerChange(e.target.value)}
          size="sm"
        />
      </div>
      <div className="w-28">
        <NumberInput
          value={purityPercent}
          onChange={(e) => {
            const parsed = parseFloat(e.target.value);
            // WHY: Reject non-numeric input instead of silently coercing to 0.
            // A 0% purity fertilizer would produce division-by-zero or infinite
            // grams-per-liter in stock solution calculations.
            if (!Number.isFinite(parsed)) return;
            onPurityChange(parsed);
          }}
          size="sm"
          min={0}
          max={100}
          unit="%"
        />
      </div>
    </div>
  );
};

export default FertilizerOptionRow;
