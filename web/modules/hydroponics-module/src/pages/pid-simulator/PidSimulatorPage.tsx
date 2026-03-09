/**
 * Dosing Simulator Page - Hydroponics pH/EC Control
 * Range-based dosing with real carbonate chemistry.
 */
import React from 'react';
import { useSimulation } from './simulation/use-simulation';
import SimDeffeyesChart from './components/SimDeffeyesChart';
import ControlPanel from './components/ControlPanel';
import PumpBars from './components/PumpBars';
import TimeSeriesCharts from './components/TimeSeriesCharts';
import StateIndicator from './components/StateIndicator';
import { calcAlkOfDicPh, alphaZero, phNbsToFree } from './engine/carbonate-chemistry';
import { CO2_EQ_MMOL } from './simulation/types';

const PidSimulatorPage: React.FC = () => {
  const sim = useSimulation();

  const phMid = (sim.config.phMin + sim.config.phMax) / 2;
  // Target ALK based on equilibrium DIC (when CO₂ reaches atmospheric equilibrium)
  const pHfree = phNbsToFree(phMid, sim.config.tempC, sim.config.salinity);
  const a0 = alphaZero(pHfree, sim.config.tempC, sim.config.salinity);
  const eqDIC = a0 > 1e-15 ? Math.min(CO2_EQ_MMOL / a0, 1e6) : 100;
  const targetALK = calcAlkOfDicPh(
    eqDIC,
    phMid,
    sim.config.tempC,
    sim.config.salinity,
  );

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="mb-4">
          <h1 className="text-xl font-bold text-gray-900">
            Dosing Simulator - Hydroponics pH/EC Control
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Carbonate chemistry model | HNO₃ / KOH dosing | Range-based control | Real-time Deffeyes diagram
          </p>
        </div>

        {/* Main Grid */}
        <div className="flex gap-4">
          {/* Left: Control Panel */}
          <ControlPanel
            state={sim.state}
            config={sim.config}
            running={sim.running}
            onConfigChange={sim.setConfig}
            onStart={sim.start}
            onStop={sim.stop}
            onReset={sim.reset}
            onDisturbance={sim.applyDisturbance}
          />

          {/* Right: Charts */}
          <div className="flex-1 min-w-0 space-y-3">
            {/* Top: Deffeyes + Pumps + State */}
            <div className="grid grid-cols-[1fr_220px] gap-3">
              <SimDeffeyesChart
                pH={sim.state.pH}
                ALK={sim.state.ALK}
                targetPH={phMid}
                targetALK={targetALK}
                tempC={sim.config.tempC}
                salinity={sim.config.salinity}
                trail={sim.trail}
              />
              <div className="space-y-3">
                <PumpBars
                  acidPump={sim.state.acidPump}
                  basePump={sim.state.basePump}
                  nutPump={sim.state.nutPump}
                  dilPump={sim.state.dilPump}
                />
                <StateIndicator
                  currentState={sim.state.state}
                />
              </div>
            </div>

            {/* Bottom: Time Series */}
            <TimeSeriesCharts
              history={sim.history}
              phMin={sim.config.phMin}
              phMax={sim.config.phMax}
              ecMin={sim.config.ecMin}
              ecMax={sim.config.ecMax}
              dt={sim.config.dt}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default PidSimulatorPage;
