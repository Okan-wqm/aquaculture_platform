/**
 * WidgetRenderer - Dynamic dispatch component
 *
 * Given a `widgetType` string, lazily loads the matching renderer from
 * `widget-renderers/` and renders it inside a React.Suspense boundary.
 *
 * Unknown types show a placeholder with the type name.
 */

import React, { Suspense, useMemo, Component, ErrorInfo } from 'react';
import type { AnimationState } from '../../engine/animation/types';

/* ------------------------------------------------------------------ */
/*  Shared severity color palette for alarm widgets                    */
/* ------------------------------------------------------------------ */

export const ALARM_SEVERITY_COLORS = {
  critical: { bg: '#ef4444', text: '#ffffff' },
  high:     { bg: '#f97316', text: '#ffffff' },
  medium:   { bg: '#eab308', text: '#000000' },
  low:      { bg: '#3b82f6', text: '#ffffff' },
  info:     { bg: '#6b7280', text: '#ffffff' },
} as const;

/* ------------------------------------------------------------------ */
/*  Common renderer props                                              */
/* ------------------------------------------------------------------ */

export interface WidgetRendererProps {
  config: Record<string, unknown>;
  value?: number | string | boolean;
  width: number;
  height: number;
  isEditing: boolean;
  onCommand?: (command: string, value?: unknown) => void;
  tagName?: string;
  label?: string;
  animationState?: AnimationState;
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
  equipment:           React.lazy(() => import('./widget-renderers/EquipmentRenderer')),
  feeder:              React.lazy(() => import('./widget-renderers/FeederRenderer')),
  radialFilter:        React.lazy(() => import('./widget-renderers/RadialFilterRenderer')),
  cleanWaterTank:      React.lazy(() => import('./widget-renderers/CleanWaterTankRenderer')),
  dirtyWaterTank:      React.lazy(() => import('./widget-renderers/DirtyWaterTankRenderer')),
  mbbr:                React.lazy(() => import('./widget-renderers/MbbrRenderer')),
  hepaFilter:          React.lazy(() => import('./widget-renderers/HepaFilterRenderer')),
  cornellDualDrain:    React.lazy(() => import('./widget-renderers/CornellDualDrainRenderer')),
  screenLink:        React.lazy(() => import('./widget-renderers/ScreenLinkRenderer')),
  staticText:        React.lazy(() => import('./widget-renderers/StaticTextRenderer')),
  pipeFlow:          React.lazy(() => import('./widget-renderers/PipeFlowRenderer')),
  svgRect:           React.lazy(() => import('./widget-renderers/SvgRectRenderer')),
  svgCircle:         React.lazy(() => import('./widget-renderers/SvgCircleRenderer')),
  svgLine:           React.lazy(() => import('./widget-renderers/SvgLineRenderer')),
  svgText:           React.lazy(() => import('./widget-renderers/SvgTextRenderer')),
};

/* ------------------------------------------------------------------ */
/*  Fallback skeleton (style injected once)                            */
/* ------------------------------------------------------------------ */

let styleInjected = false;

const Skeleton: React.FC<{ width: number; height: number }> = ({ width, height }) => {
  React.useEffect(() => {
    if (!styleInjected) {
      const style = document.createElement('style');
      style.textContent = '@keyframes widgetSpin { to { transform: rotate(360deg); } }';
      document.head.appendChild(style);
      styleInjected = true;
    }
  }, []);

  return (
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
          animation: 'widgetSpin 0.7s linear infinite',
        }}
      />
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Error Boundary                                                     */
/* ------------------------------------------------------------------ */

class WidgetErrorBoundary extends Component<
  { children: React.ReactNode; widgetType: string; width: number; height: number },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[SCADA] Widget "${this.props.widgetType}" crashed:`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          width: this.props.width, height: this.props.height,
          display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
          justifyContent: 'center', background: '#fef2f2', color: '#991b1b',
          fontSize: 11, gap: 4, padding: 8, textAlign: 'center' as const,
        }}>
          <span style={{ fontSize: 18 }}>&#9888;</span>
          <span>Widget error: {this.props.widgetType}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

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
    <span>Unknown widget: {widgetType}</span>
  </div>
);

/* ------------------------------------------------------------------ */
/*  WidgetRenderer                                                     */
/* ------------------------------------------------------------------ */

export interface WidgetRendererContainerProps extends WidgetRendererProps {
  widgetType: string;
}

export const WidgetRenderer: React.FC<WidgetRendererContainerProps> = React.memo(
  ({ widgetType, config, value, width, height, isEditing, onCommand, animationState }) => {
    const LazyComponent = useMemo(() => lazyMap[widgetType], [widgetType]);

    if (!LazyComponent) {
      return <UnknownWidget widgetType={widgetType} width={width} height={height} />;
    }

    return (
      <WidgetErrorBoundary widgetType={widgetType} width={width} height={height}>
        <Suspense fallback={<Skeleton width={width} height={height} />}>
          <LazyComponent
            config={config}
            value={value}
            width={width}
            height={height}
            isEditing={isEditing}
            onCommand={onCommand}
            animationState={animationState}
          />
        </Suspense>
      </WidgetErrorBoundary>
    );
  },
);

WidgetRenderer.displayName = 'WidgetRenderer';
