/**
 * PID Simulator Page - Hydroponics pH/EC Control
 * Layout: Control Panel (left) | Deffeyes + Time Series (right)
 */
import React from 'react';
import { useSimulation } from './simulation/use-simulation';
import SimDeffeyesChart from './components/SimDeffeyesChart';
import ControlPanel from './components/ControlPanel';
import PumpBars from './components/PumpBars';
import TimeSeriesCharts from './components/TimeSeriesCharts';
import StateIndicator from './components/StateIndicator';
import { calcAlkOfDicPh } from './engine/carbonate-chemistry';

const PidSimulatorPage: React.FC = () => {
  const sim = useSimulation();

  // Target ALK: compute from target pH and current DIC (approximate)
  const targetALK = calcAlkOfDicPh(
    sim.state.DIC,
    sim.config.targetPH,
    sim.config.tempC,
    sim.config.salinity,
  );

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="mb-4">
          <h1 className="text-xl font-bold text-gray-900">
            PID Simulator - Hydroponics pH/EC Control
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Thermodynamic plant model with Millero equations | HNO₃ / KOH dosing | Real-time Deffeyes diagram
          </p>
        </div>

        {/* Main Grid */}
        <div className="flex gap-4">
          {/* Left: Control Panel */}
          <ControlPanel
            state={sim.state}
            config={sim.config}
            phPIDParams={sim.phPIDParams}
            ecPIDParams={sim.ecPIDParams}
            running={sim.running}
            onConfigChange={sim.setConfig}
            onPhPIDChange={sim.setPhPIDParams}
            onEcPIDChange={sim.setEcPIDParams}
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
                targetPH={sim.config.targetPH}
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
                  alarmCode={sim.state.alarmCode}
                  alarmLatched={sim.state.alarmLatched}
                  onAcknowledge={sim.acknowledgeAlarm}
                />
              </div>
            </div>

            {/* Bottom: Time Series */}
            <TimeSeriesCharts
              history={sim.history}
              targetPH={sim.config.targetPH}
              targetEC={sim.config.targetEC}
              dt={sim.config.dt}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default PidSimulatorPage;
