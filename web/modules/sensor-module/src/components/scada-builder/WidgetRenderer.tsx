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

export const lazyMap: Record<string, React.LazyExoticComponent<React.ComponentType<WidgetRendererProps>>> = {
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
  customSvg:         React.lazy(() => import('./widget-renderers/CustomSvgRenderer')),
  scheduler:         React.lazy(() => import('./widget-renderers/SchedulerRenderer')),
  videoStream:       React.lazy(() => import('./widget-renderers/VideoStreamRenderer')),
  mapView:           React.lazy(() => import('./widget-renderers/MapViewRenderer')),
  svgEllipse:        React.lazy(() => import('./widget-renderers/SvgEllipseRenderer')),
  svgPath:           React.lazy(() => import('./widget-renderers/SvgPathRenderer')),
  svgPolygon:        React.lazy(() => import('./widget-renderers/SvgPolygonRenderer')),
  svgTriangle:       React.lazy(() => import('./widget-renderers/SvgTriangleRenderer')),
  svgDiamond:        React.lazy(() => import('./widget-renderers/SvgDiamondRenderer')),
  svgArrow:          React.lazy(() => import('./widget-renderers/SvgArrowRenderer')),
  rasterImage:       React.lazy(() => import('./widget-renderers/RasterImageRenderer')),
  dataTable:         React.lazy(() => import('./widget-renderers/DataTableRenderer')),
  iframe:            React.lazy(() => import('./widget-renderers/IFrameRenderer')),
  progressBar:       React.lazy(() => import('./widget-renderers/ProgressBarRenderer')),
  barChart:          React.lazy(() => import('./widget-renderers/BarChartRenderer')),
  pieChart:          React.lazy(() => import('./widget-renderers/PieChartRenderer')),
  knob:              React.lazy(() => import('./widget-renderers/KnobRenderer')),
  dropdownSelect:    React.lazy(() => import('./widget-renderers/DropdownSelectRenderer')),
  fuxaWidget:        React.lazy(() => import('./widget-renderers/FuxaWidgetRenderer')),
  vfdDrive:          React.lazy(() => import('./widget-renderers/VfdDriveWidget')),
  vfdMini:           React.lazy(() => import('./widget-renderers/VfdMiniWidget')),
  vfdGroup:          React.lazy(() => import('./widget-renderers/VfdGroupWidget')),
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

/**
 * Hata kurtarma mekanizmalı error boundary.
 * Recovery mechanism for widget error boundary.
 *
 * SCADA ortamında widget'ın kalıcı olarak bozulması kabul edilemez —
 * network kesintisi veya lazy-load hatası sonrası kullanıcı "Retry" ile
 * widget'ı kurtarabilmeli. 3 deneme sonrası kalıcı hata gösterilir.
 *
 * In SCADA environments, permanent widget failure is unacceptable —
 * after a transient network or lazy-load error the user should be able
 * to recover via "Retry". After 3 attempts a permanent error is shown.
 */
interface WidgetErrorBoundaryProps {
  children: React.ReactNode;
  widgetType: string;
  width: number;
  height: number;
}

interface WidgetErrorBoundaryState {
  hasError: boolean;
  /** Toplam retry sayısı / Total retry count */
  errorCount: number;
}

/** Kalıcı hata kabul edilmeden önceki maksimum deneme / Max retries before permanent failure */
const MAX_RETRIES = 3;

class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, WidgetErrorBoundaryState> {
  state: WidgetErrorBoundaryState = { hasError: false, errorCount: 0 };

  static getDerivedStateFromError(): Pick<WidgetErrorBoundaryState, 'hasError'> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[SCADA] Widget "${this.props.widgetType}" crashed:`, error, info);
  }

  componentDidUpdate(prevProps: WidgetErrorBoundaryProps): void {
    // Widget tipi değiştiğinde hata state'ini sıfırla — yeni widget temiz başlamalı
    // Reset error state when widget type changes — new widget should start clean
    if (prevProps.widgetType !== this.props.widgetType && this.state.hasError) {
      this.setState({ hasError: false, errorCount: 0 });
    }
  }

  /**
   * Geçici hatadan kurtarma: state sıfırlanır, React children'ı tekrar render eder.
   * Transient error recovery: state resets, React re-renders children.
   */
  handleRetry = (): void => {
    this.setState((prev) => ({ hasError: false, errorCount: prev.errorCount + 1 }));
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      const canRetry = this.state.errorCount < MAX_RETRIES;

      return (
        <div style={{
          width: this.props.width, height: this.props.height,
          display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
          justifyContent: 'center', background: '#fef2f2', color: '#991b1b',
          fontSize: 11, gap: 6, padding: 8, textAlign: 'center' as const,
        }}>
          <span style={{ fontSize: 18 }}>&#9888;</span>
          <span>Widget error: {this.props.widgetType}</span>
          {canRetry ? (
            <button
              onClick={this.handleRetry}
              style={{
                marginTop: 4, padding: '3px 10px', fontSize: 10, fontWeight: 600,
                background: '#fff', color: '#991b1b', border: '1px solid #fca5a5',
                borderRadius: 4, cursor: 'pointer',
              }}
            >
              Retry ({MAX_RETRIES - this.state.errorCount} left)
            </button>
          ) : (
            /* 3 deneme sonrası kalıcı hata — sayfa yenilenmeli */
            /* After 3 retries, permanent failure — page must be refreshed */
            <span style={{ fontSize: 9, color: '#b91c1c', marginTop: 2 }}>
              Widget could not recover — please refresh
            </span>
          )}
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
