/**
 * On-Demand Dosing Results Panel
 *
 * Displays the step-by-step results of the forward dosing simulation.
 * Inputs are configured via the "Simulator" tab in the InputPanel.
 */
import React from 'react';
import { OnDemandStep } from '../engine/types';

interface OnDemandPanelProps {
  steps: OnDemandStep[];
  co2ToxicMgL: number;
}

const OnDemandPanel: React.FC<OnDemandPanelProps> = ({ steps, co2ToxicMgL }) => {
  if (steps.length < 2) return null;

  const pHColor = (ph: number) => {
    if (ph < 6.5 || ph > 8.5) return 'text-red-600';
    if (ph < 7.0 || ph > 8.0) return 'text-yellow-600';
    return 'text-green-700';
  };

  const co2Color = (co2: number) => {
    if (co2 > co2ToxicMgL) return 'text-red-600';
    if (co2 > co2ToxicMgL * 0.75) return 'text-yellow-600';
    return 'text-green-700';
  };

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-gray-900">Dosing Simulator — Results</h3>
        <p className="text-xs text-gray-500 mt-0.5">Projected water chemistry after each dosing step</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-2 py-1.5 font-medium text-gray-600">Step</th>
              <th className="text-right px-2 py-1.5 font-medium text-gray-600">pH</th>
              <th className="text-right px-2 py-1.5 font-medium text-gray-600">ALK (meq/L)</th>
              <th className="text-right px-2 py-1.5 font-medium text-gray-600">DIC (mmol/L)</th>
              <th className="text-right px-2 py-1.5 font-medium text-gray-600">CO₂ (mg/L)</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step, idx) => {
              const isStart = idx === 0;
              const isFinal = idx === steps.length - 1;
              return (
                <tr
                  key={idx}
                  className={`border-b border-gray-100 ${isFinal ? 'bg-orange-50 font-medium' : isStart ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                >
                  <td className="px-2 py-1.5 text-gray-700">
                    {isStart && <span className="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1.5 align-middle" />}
                    {isFinal && !isStart && <span className="inline-block w-2 h-2 rounded-full bg-orange-500 mr-1.5 align-middle" />}
                    {!isStart && !isFinal && <span className="inline-block w-2 h-2 border border-orange-400 rounded-full mr-1.5 align-middle" />}
                    {step.label}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${pHColor(step.ph)}`}>
                    {step.ph.toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {step.alk.toFixed(3)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {step.dic.toFixed(3)}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${co2Color(step.co2)}`}>
                    {step.co2.toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex gap-4 mt-2 text-xs text-gray-500">
          <span>
            ΔpH: <span className={pHColor(steps[steps.length - 1].ph)}>
              {(steps[steps.length - 1].ph - steps[0].ph > 0 ? '+' : '')}{(steps[steps.length - 1].ph - steps[0].ph).toFixed(2)}
            </span>
          </span>
          <span>
            ΔALK: {(steps[steps.length - 1].alk - steps[0].alk > 0 ? '+' : '')}{(steps[steps.length - 1].alk - steps[0].alk).toFixed(3)} meq/L
          </span>
          <span>
            ΔDIC: {(steps[steps.length - 1].dic - steps[0].dic > 0 ? '+' : '')}{(steps[steps.length - 1].dic - steps[0].dic).toFixed(3)} mmol/L
          </span>
          <span>
            ΔCO₂: <span className={co2Color(steps[steps.length - 1].co2)}>
              {(steps[steps.length - 1].co2 - steps[0].co2 > 0 ? '+' : '')}{(steps[steps.length - 1].co2 - steps[0].co2).toFixed(1)} mg/L
            </span>
          </span>
        </div>
      </div>
    </div>
  );
};

export default OnDemandPanel;
