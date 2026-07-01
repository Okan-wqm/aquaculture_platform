/**
 * Results Panel - Horizontal 3-column layout for calculated outputs and dosing recipes
 */
import type { CalculatedOutputs } from '@platform/aquaculture-engines';
import React from 'react';

interface ResultsPanelProps {
  outputs: CalculatedOutputs | null;
}

const ResultsPanel: React.FC<ResultsPanelProps> = ({ outputs }) => {
  if (!outputs) {
    return (
      <div className="bg-white rounded-lg shadow p-4">
        <p className="text-sm text-gray-400 text-center">Calculating...</p>
      </div>
    );
  }

  const statusConfig = {
    safe: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700', icon: '✓', label: 'SAFE' },
    alert: { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-700', icon: '⚠', label: 'ALERT' },
    danger: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', icon: '✗', label: 'DANGER' },
  };
  const status = statusConfig[outputs.uiaStatusLevel];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {/* Column 1: UIA Safety Status */}
      <div className={`rounded-lg shadow p-4 ${status.bg} border ${status.border}`}>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">{status.icon}</span>
          <h4 className={`text-sm font-bold ${status.text}`}>UIA Status: {status.label}</h4>
        </div>
        <div className="space-y-2">
          <ResultRow
            label="Current NH₃-N"
            value={outputs.currentUIA.toFixed(4)}
            unit="mg/L"
            color={outputs.uiaStatusLevel === 'danger' ? 'text-red-600' : undefined}
          />
          <ResultRow
            label="Safe TAN (max)"
            value={outputs.safeTAN > 100 ? '> 100' : outputs.safeTAN.toFixed(2)}
            unit="mg/L"
          />
          <ResultRow
            label="pH margin to critical"
            value={isNaN(outputs.deltaPH) ? 'N/A' : `${outputs.deltaPH > 0 ? '+' : ''}${outputs.deltaPH.toFixed(2)}`}
            unit="pH"
            color={
              isNaN(outputs.deltaPH) ? 'text-gray-400' :
              outputs.deltaPH > 0.2 ? 'text-green-600' :
              outputs.deltaPH > 0 ? 'text-yellow-600' : 'text-red-600'
            }
          />
          <div className="border-t pt-2 mt-2" />
          <ResultRow
            label="Toxic NH₃ pH Border"
            value={isNaN(outputs.toxicNH3pH) ? 'N/A' : outputs.toxicNH3pH.toFixed(3)}
            unit="NBS"
            color={!isNaN(outputs.toxicNH3pH) ? 'text-red-600' : undefined}
          />
          <ResultRow
            label="UIA-N % at NH₃ Border"
            value={isNaN(outputs.uiaNPercent) ? 'N/A' : outputs.uiaNPercent.toFixed(3)}
            unit="%"
          />
        </div>
      </div>

      {/* Column 2: H₂S Safety Status */}
      {(() => {
        const h2sStatusConfig = statusConfig[outputs.h2sStatusLevel];
        return (
          <div className={`rounded-lg shadow p-4 ${h2sStatusConfig.bg} border ${h2sStatusConfig.border}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">{h2sStatusConfig.icon}</span>
              <h4 className={`text-sm font-bold ${h2sStatusConfig.text}`}>H₂S Status: {h2sStatusConfig.label}</h4>
            </div>
            <div className="space-y-2">
              <ResultRow
                label="Current H₂S"
                value={outputs.currentH2S.toFixed(1)}
                unit="µg/L"
                color={outputs.h2sStatusLevel === 'danger' ? 'text-red-600' : undefined}
              />
              <ResultRow
                label="Total Sulfide (calc)"
                value={outputs.totalSulfide > 10000 ? '> 10000' : outputs.totalSulfide.toFixed(1)}
                unit="µg/L"
              />
              <ResultRow
                label="Safe Total Sulfide (max)"
                value={outputs.safeTotalSulfide > 10000 ? '> 10000' : outputs.safeTotalSulfide.toFixed(1)}
                unit="µg/L"
              />
              <ResultRow
                label="pH margin to critical"
                value={isNaN(outputs.h2sDeltaPH) ? 'N/A' : `${outputs.h2sDeltaPH > 0 ? '+' : ''}${outputs.h2sDeltaPH.toFixed(2)}`}
                unit="pH"
                color={
                  isNaN(outputs.h2sDeltaPH) ? 'text-gray-400' :
                  outputs.h2sDeltaPH > 0.2 ? 'text-green-600' :
                  outputs.h2sDeltaPH > 0 ? 'text-yellow-600' : 'text-red-600'
                }
              />
              <div className="border-t pt-2 mt-2" />
              <ResultRow
                label="Toxic H₂S pH Border"
                value={isNaN(outputs.toxicH2SpH) ? 'N/A' : outputs.toxicH2SpH.toFixed(3)}
                unit="NBS"
                color={!isNaN(outputs.toxicH2SpH) ? 'text-red-600' : undefined}
              />
            </div>
          </div>
        );
      })()}

      {/* Column 3: Calculated Values */}
      <div className="bg-white rounded-lg shadow p-4">
        <h4 className="text-sm font-semibold text-gray-800 mb-3 border-b pb-1">Calculated Values</h4>
        <div className="space-y-2">
          <ResultRow
            label="Toxic CO₂ pH Border"
            value={isNaN(outputs.toxicCO2pH) ? 'N/A' : outputs.toxicCO2pH.toFixed(3)}
            unit="NBS"
            color={!isNaN(outputs.toxicCO2pH) ? 'text-red-600' : undefined}
          />
          <ResultRow
            label="Current CO₂"
            value={outputs.currentCO2.toFixed(2)}
            unit="mg/L"
            color={outputs.currentCO2 > 20 ? 'text-yellow-600' : 'text-green-600'}
          />
          <ResultRow
            label="Target CO₂"
            value={outputs.targetCO2.toFixed(2)}
            unit="mg/L"
          />
          <ResultRow
            label="Current DIC"
            value={outputs.currentDIC.toFixed(3)}
            unit="mmol/L"
          />
          <ResultRow
            label="Target DIC"
            value={outputs.targetDIC.toFixed(3)}
            unit="mmol/L"
          />
        </div>
      </div>

      {/* Column 4: Dosing Recipes */}
      <div className="bg-white rounded-lg shadow p-4">
        <h4 className="text-sm font-semibold text-gray-800 mb-3 border-b pb-1">
          Dosing Recipes {outputs.dosingRecipes.length > 0 && `(${outputs.dosingRecipes.length})`}
        </h4>
        {outputs.dosingRecipes.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">No recipes available. Select reagents and set target.</p>
        ) : (
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {outputs.dosingRecipes.map((recipe, idx) => (
              <div key={idx} className="border rounded p-2 bg-gray-50">
                <p className="text-xs font-medium text-gray-700 mb-1">
                  {idx + 1}. {recipe.description}
                </p>
                {recipe.steps.map((step, si) => (
                  <div key={si} className="flex items-center gap-2 text-xs text-gray-600 ml-3">
                    <span className="text-blue-600 font-medium">{step.formula}</span>
                    <span>
                      {step.amountGrams < 1000
                        ? `${step.amountGrams.toFixed(1)} g`
                        : `${step.amountKg.toFixed(3)} kg`}
                    </span>
                    <span className="text-gray-400">
                      (ΔAlk: {step.deltaAlk >= 0 ? '+' : ''}{step.deltaAlk.toFixed(3)},
                      {' '}ΔDIC: {step.deltaDIC >= 0 ? '+' : ''}{step.deltaDIC.toFixed(3)})
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const ResultRow: React.FC<{
  label: string;
  value: string;
  unit: string;
  color?: string;
}> = ({ label, value, unit, color }) => (
  <div className="flex items-center justify-between">
    <span className="text-xs text-gray-600">{label}</span>
    <span className={`text-xs font-medium ${color || 'text-gray-900'}`}>
      {value} <span className="text-gray-400 font-normal">{unit}</span>
    </span>
  </div>
);

export default ResultsPanel;
