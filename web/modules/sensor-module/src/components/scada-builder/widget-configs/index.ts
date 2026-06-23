import React from 'react';
import { GaugeConfig } from './GaugeConfig';
import { NumericDisplayConfig } from './NumericDisplayConfig';
import { StatusIndicatorConfig } from './StatusIndicatorConfig';
import { TankLevelConfig } from './TankLevelConfig';
import { TrendChartConfig } from './TrendChartConfig';
import { AlarmBannerConfig } from './AlarmBannerConfig';
import { AlarmListConfig } from './AlarmListConfig';
import { ToggleSwitchConfig } from './ToggleSwitchConfig';
import { SliderConfig } from './SliderConfig';
import { NumericInputConfig } from './NumericInputConfig';
import { PushButtonConfig } from './PushButtonConfig';
import { EmergencyStopConfig } from './EmergencyStopConfig';
import { CalibrationWizardConfig } from './CalibrationWizardConfig';
import { CalibrationHistoryConfig } from './CalibrationHistoryConfig';
import { CalibrationStatusConfig } from './CalibrationStatusConfig';
import { ProcessViewConfig } from './ProcessViewConfig';
import { EquipmentConfig } from './EquipmentConfig';
import { FeederConfig } from './FeederConfig';
import { RadialFilterConfig } from './RadialFilterConfig';
import { CleanWaterTankConfig } from './CleanWaterTankConfig';
import { DirtyWaterTankConfig } from './DirtyWaterTankConfig';
import { MbbrConfig } from './MbbrConfig';
import { HepaFilterConfig } from './HepaFilterConfig';
import { CornellDualDrainConfig } from './CornellDualDrainConfig';
import { ScreenLinkConfig } from './ScreenLinkConfig';
import { StaticTextConfig } from './StaticTextConfig';
import { PipeFlowConfig } from './PipeFlowConfig';
import { SvgRectConfig, SvgCircleConfig, SvgLineConfig, SvgTextConfig, SvgPolygonConfig, SvgTriangleConfig, SvgDiamondConfig, SvgArrowConfig } from './SvgShapeConfig';
import { CustomSvgConfig } from './CustomSvgConfig';
import { SchedulerConfig } from './SchedulerConfig';
import { VideoStreamConfig } from './VideoStreamConfig';
import { MapViewConfig } from './MapViewConfig';
import { SvgEllipseConfig } from './SvgEllipseConfig';
import { SvgPathConfig } from './SvgPathConfig';
import { RasterImageConfig } from './RasterImageConfig';
import { DataTableConfig } from './DataTableConfig';
import { IFrameConfig } from './IFrameConfig';
import { ProgressBarConfig } from './ProgressBarConfig';
import { BarChartConfig } from './BarChartConfig';
import { PieChartConfig } from './PieChartConfig';
import { KnobConfig } from './KnobConfig';
import { DropdownSelectConfig } from './DropdownSelectConfig';
import { FuxaWidgetConfig } from './FuxaWidgetConfig';
import { VfdDriveWidgetConfig } from './VfdDriveWidgetConfig';

interface WidgetConfigProps {
  config: Record<string, any>;  
  onChange: (updates: Record<string, any>) => void;  
  deviceId?: string | null;
}

export const widgetConfigMap: Record<string, React.FC<WidgetConfigProps>> = {
  gauge: GaugeConfig,
  numericDisplay: NumericDisplayConfig,
  statusIndicator: StatusIndicatorConfig,
  tankLevel: TankLevelConfig,
  trendChart: TrendChartConfig,
  alarmBanner: AlarmBannerConfig,
  alarmList: AlarmListConfig,
  toggleSwitch: ToggleSwitchConfig,
  slider: SliderConfig,
  numericInput: NumericInputConfig,
  pushButton: PushButtonConfig,
  emergencyStop: EmergencyStopConfig,
  calibrationWizard: CalibrationWizardConfig,
  calibrationHistory: CalibrationHistoryConfig,
  calibrationStatus: CalibrationStatusConfig,
  processView: ProcessViewConfig,
  equipment: EquipmentConfig,
  feeder: FeederConfig,
  radialFilter: RadialFilterConfig,
  cleanWaterTank: CleanWaterTankConfig,
  dirtyWaterTank: DirtyWaterTankConfig,
  mbbr: MbbrConfig,
  hepaFilter: HepaFilterConfig,
  cornellDualDrain: CornellDualDrainConfig,
  screenLink: ScreenLinkConfig,
  staticText: StaticTextConfig,
  pipeFlow: PipeFlowConfig,
  svgRect: SvgRectConfig,
  svgCircle: SvgCircleConfig,
  svgLine: SvgLineConfig,
  svgText: SvgTextConfig,
  customSvg: CustomSvgConfig,
  scheduler: SchedulerConfig,
  videoStream: VideoStreamConfig,
  mapView: MapViewConfig,
  svgEllipse: SvgEllipseConfig,
  svgPath: SvgPathConfig,
  svgPolygon: SvgPolygonConfig,
  svgTriangle: SvgTriangleConfig,
  svgDiamond: SvgDiamondConfig,
  svgArrow: SvgArrowConfig,
  rasterImage: RasterImageConfig,
  dataTable: DataTableConfig,
  iframe: IFrameConfig,
  progressBar: ProgressBarConfig,
  barChart: BarChartConfig,
  pieChart: PieChartConfig,
  knob: KnobConfig,
  dropdownSelect: DropdownSelectConfig,
  fuxaWidget: FuxaWidgetConfig,
  vfdDrive: VfdDriveWidgetConfig,
  vfdMini: VfdDriveWidgetConfig,
  vfdGroup: VfdDriveWidgetConfig,
};
