/**
 * Locale keys for the persona catalogue's capability strings.
 *
 * The catalogue publishes capabilities as English display strings (no ids), so this table keys
 * them by that exact string. `satisfies` holds every value to an existing locale key, and
 * aiPersona.spec pins the other direction: every published capability has an entry whose English
 * text IS that string, and no entry outlives the catalogue — a catalogue edit without a locale
 * edit fails the build.
 */
import type { MessageKey } from '@aquaculture/shared-ui';

export const PERSONA_CAPABILITY_KEYS = {
  'Water quality parameters': 'messaging.persona.cap.waterQualityParameters',
  'Sensor readings': 'messaging.persona.cap.sensorReadings',
  'Ammonia/H2S/CO2 toxicity': 'messaging.persona.cap.gasToxicity',
  'Carbonate chemistry': 'messaging.persona.cap.carbonateChemistry',
  'Report generation': 'messaging.persona.cap.reportGeneration',
  'Biomass/SGR/FCR analytics': 'messaging.persona.cap.biomassAnalytics',
  'Trend analysis': 'messaging.persona.cap.trendAnalysis',
  'Feed management': 'messaging.persona.cap.feedManagement',
  'Alert analysis': 'messaging.persona.cap.alertAnalysis',
  'Growth analytics': 'messaging.persona.cap.growthAnalytics',
  'Feed optimization': 'messaging.persona.cap.feedOptimization',
  'Reagent dosing': 'messaging.persona.cap.reagentDosing',
  'Risk assessment': 'messaging.persona.cap.riskAssessment',
  'Actuation (with confirmation)': 'messaging.persona.cap.actuationConfirmed',
  'Autonomous monitoring': 'messaging.persona.cap.autonomousMonitoring',
  'Equipment actuation': 'messaging.persona.cap.equipmentActuation',
  'PLC control': 'messaging.persona.cap.plcControl',
  'Safety limit enforcement': 'messaging.persona.cap.safetyLimits',
  'Escalation management': 'messaging.persona.cap.escalationManagement',
  'General questions': 'messaging.persona.cap.generalQuestions',
  'Basic guidance': 'messaging.persona.cap.basicGuidance',
  'Platform help': 'messaging.persona.cap.platformHelp',
  'Water quality trends & thresholds': 'messaging.persona.cap.waterTrends',
  'Health events & treatments': 'messaging.persona.cap.healthEvents',
  'Lice counts & welfare': 'messaging.persona.cap.liceWelfare',
  'Harvest eligibility (withdrawal)': 'messaging.persona.cap.harvestWithdrawal',
  'Batch performance & growth': 'messaging.persona.cap.batchPerformance',
  'Feeding plans & consumption': 'messaging.persona.cap.feedingPlans',
  'Harvest plans & eligibility': 'messaging.persona.cap.harvestPlans',
  'Biomass & regulatory reports': 'messaging.persona.cap.biomassReports',
  'Finance summaries': 'messaging.persona.cap.financeSummaries',
  'Tasks & work orders': 'messaging.persona.cap.tasksWorkOrders',
  'Maintenance alerts': 'messaging.persona.cap.maintenanceAlerts',
  'Equipment & feeder calibration': 'messaging.persona.cap.equipmentCalibration',
  'Spare parts & farm stock': 'messaging.persona.cap.sparePartsStock',
  'Task creation (with confirmation)': 'messaging.persona.cap.taskCreation',
} as const satisfies Record<string, MessageKey>;

const KEYS: Readonly<Record<string, MessageKey | undefined>> = PERSONA_CAPABILITY_KEYS;

/** A capability in the caller's language; an unmapped string shows as published. */
export function capabilityLabel(capability: string, t: (key: MessageKey) => string): string {
  const key = KEYS[capability];
  return key === undefined ? capability : t(key);
}
