/**
 * WidgetRenderer - Dynamic dispatch component
 *
 * Given a `widgetType` string, lazily loads the matching renderer from
 * `widget-renderers/` and renders it inside a React.Suspense boundary.
 *
 * Unknown types show a placeholder with the type name.
 */

import React, { Suspense, useMemo } from 'react';

/* ------------------------------------------------------------------ */
/*  Common renderer props                                              */
/* ------------------------------------------------------------------ */

export interface WidgetRendererProps {
  config: Record<string, any>;
  value?: number | string | boolean;
  width: number;
  height: number;
  isEditing: boolean;
}

/* ------------------------------------------------------------------ */
/*  Lazy map — each entry resolves to a default-exported React.FC      */
/* ------------------------------------------------------------------ */

const lazyMap: Record<string, React.LazyExoticComponent<React.ComponentType<WidgetRendererProps>>> = {
  gauge:               React.lazy(() => import('./widget-renderers/GaugeRenderer')),
  numericDisplay:      React.lazy(() => import('./widget-renderers/NumericDisplayRenderer')),
  statusIndicator:     React.lazy(() => import('./widget-renderers/StatusIndicatorRenderer')),
  tankLevel:           React.lazy(() => import('./widget-renderers/TankLevelRenderer')),
  toggleSwitch:        React.lazy(() => import('./widget-renderers/ToggleSwitchRenderer')),
  slider:              React.lazy(() => import('./widget-renderers/SliderRenderer')),
  numericInput:        React.lazy(() => import('./widget-renderers/NumericInputRenderer')),
  pushButton:          React.lazy(() => import('./widget-renderers/PushButtonRenderer')),
  emergencyStop:       React.lazy(() => import('./widget-renderers/EmergencyStopRenderer')),
  trendChart:          React.lazy(() => import('./widget-renderers/TrendChartRenderer')),
  alarmBanner:         React.lazy(() => import('./widget-renderers/AlarmBannerRenderer')),
  alarmList:           React.lazy(() => import('./widget-renderers/AlarmListRenderer')),
  calibrationWizard:   React.lazy(() => import('./widget-renderers/CalibrationWizardRenderer')),
  calibrationHistory:  React.lazy(() => import('./widget-renderers/CalibrationHistoryRenderer')),
  calibrationStatus:   React.lazy(() => import('./widget-renderers/CalibrationStatusRenderer')),
  processView:         React.lazy(() => import('./widget-renderers/ProcessViewRenderer')),
};

/* ------------------------------------------------------------------ */
/*  Fallback skeleton                                                  */
/* ------------------------------------------------------------------ */

const Skeleton: React.FC<{ width: number; height: number }> = ({ width, height }) => (
  <div
    style={{
      width,
      height,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f8fafc',
    }}
  >
    <div
      style={{
        width: 24,
        height: 24,
        border: '3px solid #e2e8f0',
        borderTopColor: '#06b6d4',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
      }}
    />
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);

/* ------------------------------------------------------------------ */
/*  Unknown type placeholder                                           */
/* ------------------------------------------------------------------ */

const UnknownWidget: React.FC<{ widgetType: string; width: number; height: number }> = ({
  widgetType,
  width,
  height,
}) => (
  <div
    style={{
      width,
      height,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#fef2f2',
      color: '#991b1b',
      fontSize: 12,
      fontWeight: 500,
      gap: 4,
      padding: 8,
      textAlign: 'center',
    }}
  >
    <span style={{ fontSize: 20 }}>?</span>
    <span>Bilinmeyen widget: {widgetType}</span>
  </div>
);

/* ------------------------------------------------------------------ */
/*  WidgetRenderer                                                     */
/* ------------------------------------------------------------------ */

export interface WidgetRendererContainerProps extends WidgetRendererProps {
  widgetType: string;
}

export const WidgetRenderer: React.FC<WidgetRendererContainerProps> = React.memo(
  ({ widgetType, config, value, width, height, isEditing }) => {
    const LazyComponent = useMemo(() => lazyMap[widgetType], [widgetType]);

    if (!LazyComponent) {
      return <UnknownWidget widgetType={widgetType} width={width} height={height} />;
    }

    return (
      <Suspense fallback={<Skeleton width={width} height={height} />}>
        <LazyComponent
          config={config}
          value={value}
          width={width}
          height={height}
          isEditing={isEditing}
        />
      </Suspense>
    );
  },
);

WidgetRenderer.displayName = 'WidgetRenderer';
