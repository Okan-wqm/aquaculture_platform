/**
 * CalibrationWizardRenderer - Step indicator placeholder
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const STEPS = ['Hazirlik', 'Buffer 1', 'Buffer 2', 'Dogrulama', 'Tamam'];

const CalibrationWizardRenderer: React.FC<WidgetRendererProps> = ({ config, width, height, isEditing }) => {
  const label = config.label ?? 'Kalibrasyon';
  const currentStep = isEditing ? (config.demoStep ?? 2) : Number(config.currentStep ?? 0);
  const steps = config.steps ?? STEPS;
  const stepCount = steps.length;

  const padX = 24;
  const stepSpacing = (width - padX * 2) / (stepCount - 1 || 1);

  const h = height - 16; // inner height after padding
  const svgH = Math.min(h * 0.35, 60);

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' as const, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '0 2px 4px', fontSize: 11, fontWeight: 600, color: '#374151' }}>
        {label}
      </div>

      {/* Step indicator */}
      <svg width="100%" height={svgH} viewBox={`0 0 ${width} ${svgH}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', flexShrink: 0 }}>
        {/* Connecting line */}
        <line
          x1={padX}
          y1={20}
          x2={padX + stepSpacing * (stepCount - 1)}
          y2={20}
          stroke="#e5e7eb"
          strokeWidth={2}
        />
        {/* Completed line */}
        {currentStep > 0 && (
          <line
            x1={padX}
            y1={20}
            x2={padX + stepSpacing * Math.min(currentStep, stepCount - 1)}
            y2={20}
            stroke="#22c55e"
            strokeWidth={2}
          />
        )}

        {/* Step circles */}
        {steps.map((step: string, i: number) => {
          const x = padX + i * stepSpacing;
          const done = i < currentStep;
          const active = i === currentStep;
          return (
            <g key={i}>
              <circle
                cx={x}
                cy={20}
                r={8}
                fill={done ? '#22c55e' : active ? '#3b82f6' : '#e5e7eb'}
                stroke={active ? '#93c5fd' : 'none'}
                strokeWidth={active ? 2 : 0}
              />
              <text x={x} y={23} textAnchor="middle" fontSize={8} fontWeight={700} fill={done || active ? 'white' : '#9ca3af'}>
                {done ? '\u2713' : i + 1}
              </text>
              <text x={x} y={42} textAnchor="middle" fontSize={7} fill={active ? '#1d4ed8' : '#9ca3af'}>
                {step}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Content placeholder */}
      <div
        style={{
          flex: 1,
          margin: '0 10px 8px',
          background: '#f8fafc',
          borderRadius: 4,
          border: '1px dashed #d1d5db',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          color: '#9ca3af',
        }}
      >
        Adim {currentStep + 1}: {steps[currentStep] ?? ''}
      </div>
    </div>
  );
};

CalibrationWizardRenderer.displayName = 'CalibrationWizardRenderer';
export default memo(CalibrationWizardRenderer);
