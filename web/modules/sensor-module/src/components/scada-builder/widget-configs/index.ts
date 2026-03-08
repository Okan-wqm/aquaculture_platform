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
};
