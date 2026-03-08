/**
 * Time Series Charts - pH, EC, Pump outputs, DIC/ALK
 * Shows target ranges as shaded bands.
 */
import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
} from 'recharts';
import { SimSnapshot } from '../simulation/types';

interface TimeSeriesChartsProps {
  history: SimSnapshot[];
  phMin: number;
  phMax: number;
  ecMin: number;
  ecMax: number;
  dt: number;
}

const ChartWrapper: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-white rounded-lg border border-gray-200 p-2">
    <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">{title}</h4>
    <div style={{ height: 110 }}>
      {children}
    </div>
  </div>
);

const TimeSeriesCharts: React.FC<TimeSeriesChartsProps> = ({
  history, phMin, phMax, ecMin, ecMax, dt,
}) => {
  const data = history.map(s => ({
    t: parseFloat((s.tick * dt).toFixed(1)),
    pH: s.pH,
    EC: s.EC,
    acid: s.acidPump,
    base: s.basePump,
    nut: s.nutPump,
    dil: s.dilPump,
    DIC: s.DIC,
    ALK: s.ALK,
  }));

  if (data.length === 0) {
    return (
      <div className="space-y-2">
        {['pH', 'EC', 'Pumps', 'DIC / ALK'].map(t => (
          <ChartWrapper key={t} title={t}>
            <div className="flex items-center justify-center h-full text-[11px] text-gray-400">
              No data - press START
            </div>
          </ChartWrapper>
        ))}
      </div>
    );
  }

  const tMin = data[0].t;
  const tMax = data[data.length - 1].t;

  return (
    <div className="space-y-2">
      {/* pH */}
      <ChartWrapper title="pH">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 2, right: 5, left: -15, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="t" type="number" domain={[tMin, tMax]} tick={{ fontSize: 9 }} />
            <YAxis tick={{ fontSize: 9 }} domain={['auto', 'auto']} />
            <ReferenceArea y1={phMin} y2={phMax} fill="#16a34a" fillOpacity={0.1} strokeOpacity={0} />
            <Line dataKey="pH" stroke="#2563eb" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartWrapper>

      {/* EC */}
      <ChartWrapper title="EC (mS/cm)">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 2, right: 5, left: -15, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="t" type="number" domain={[tMin, tMax]} tick={{ fontSize: 9 }} />
            <YAxis tick={{ fontSize: 9 }} domain={['auto', 'auto']} />
            <ReferenceArea y1={ecMin} y2={ecMax} fill="#16a34a" fillOpacity={0.1} strokeOpacity={0} />
            <Line dataKey="EC" stroke="#ea580c" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartWrapper>

      {/* Pump outputs */}
      <ChartWrapper title="Pump Outputs (%)">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 2, right: 5, left: -15, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="t" type="number" domain={[tMin, tMax]} tick={{ fontSize: 9 }} />
            <YAxis tick={{ fontSize: 9 }} domain={[0, 100]} />
            <Line dataKey="acid" stroke="#e11d48" strokeWidth={1} dot={false} isAnimationActive={false} />
            <Line dataKey="base" stroke="#16a34a" strokeWidth={1} dot={false} isAnimationActive={false} />
            <Line dataKey="nut" stroke="#ea580c" strokeWidth={1} dot={false} isAnimationActive={false} />
            <Line dataKey="dil" stroke="#2563eb" strokeWidth={1} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartWrapper>

      {/* DIC / ALK */}
      <ChartWrapper title="DIC / ALK">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 2, right: 5, left: -15, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="t" type="number" domain={[tMin, tMax]} tick={{ fontSize: 9 }} />
            <YAxis tick={{ fontSize: 9 }} domain={['auto', 'auto']} />
            <Line dataKey="DIC" stroke="#7c3aed" strokeWidth={1.5} dot={false} isAnimationActive={false} name="DIC" />
            <Line dataKey="ALK" stroke="#0891b2" strokeWidth={1.5} dot={false} isAnimationActive={false} name="ALK" />
          </LineChart>
        </ResponsiveContainer>
      </ChartWrapper>
    </div>
  );
};

export default TimeSeriesCharts;
