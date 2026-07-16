/**
 * Tenant Admin Constants - Single Source of Truth
 *
 * MED-15: MODULE_REGISTRY replaces scattered name.toLowerCase().includes()
 * heuristics in TenantDashboard, TenantModules, and TenantDatabase.
 *
 * MED-18: ROLE_COLORS moved here from inline duplicates.
 */

export interface ModuleRegistryEntry {
  code: string;
  label: string;
  icon: string;
  defaultRoute: string;
  features: string[];
  tables: string[];
}

export const MODULE_REGISTRY: Record<string, ModuleRegistryEntry> = {
  farm: {
    code: 'farm',
    label: 'Farm Module',
    icon: '\uD83D\uDC1F',
    defaultRoute: '/farm/dashboard',
    features: ['Site Management', 'Tank Tracking', 'Batch Management', 'Feeding', 'Growth Monitoring'],
    tables: [
      'farms', 'sites', 'departments', 'ponds', 'tanks', 'tank_allocations', 'tank_batches', 'tank_operations',
      'batches', 'batches_v2', 'batch_documents', 'batch_feed_assignments', 'batch_locations', 'species',
      'systems', 'sub_systems', 'equipment_types', 'equipment', 'equipment_systems', 'sub_equipment_types', 'sub_equipment',
      'maintenance_schedules', 'work_orders', 'spare_parts',
      'feed_types', 'feed_type_species', 'feeds', 'feed_inventory', 'feed_sites', 'feeding_protocols', 'feeding_records',
      'feeding_tables', 'feeding_programs', 'feeding_program_tanks', 'daily_feeding_executions',
      'feeding_protocols_v2', 'feeding_protocol_assignments',
      'chemical_types', 'chemicals', 'chemical_sites',
      'growth_measurements', 'mortality_records', 'water_quality_measurements', 'health_events', 'harvest_plans', 'harvest_records',
      'supplier_types', 'suppliers',
      'code_sequences', 'farm_audit_logs', 'regulatory_settings', 'sentinel_hub_settings',
    ],
  },
  sensor: {
    code: 'sensor',
    label: 'Sensor Module',
    icon: '\uD83D\uDCCA',
    defaultRoute: '/sensor/dashboard',
    features: ['Real-time Data', 'Alerts', 'Historical Trends', 'Device Management'],
    tables: [
      'sensors', 'sensor_readings', 'sensor_metrics', 'sensor_data_channels', 'sensor_protocols',
      'processes', 'vfd_devices', 'vfd_readings', 'vfd_register_mappings',
      'dashboard_layouts', 'edge_devices', 'device_io_configs',
      'plc_connections', 'plc_alarms', 'plc_telemetry', 'feeding_parameters',
      'automation_programs', 'program_steps', 'program_transitions', 'program_variables', 'step_actions',
    ],
  },
  hr: {
    code: 'hr',
    label: 'HR Module',
    icon: '\uD83D\uDC65',
    defaultRoute: '/hr/dashboard',
    features: ['Employee Records', 'Attendance', 'Payroll', 'Leave Management'],
    tables: [
      'employees', 'payrolls',
      'leave_types', 'leave_balances', 'leave_requests',
      'shifts', 'schedules', 'schedule_entries', 'scheduling_settings', 'attendance_records',
      'weekly_plans', 'weekly_plan_entries',
      'training_courses', 'training_enrollments',
      'certification_types', 'employee_certifications',
      'work_areas', 'work_rotations', 'safety_training_records',
    ],
  },
  hydroponics: {
    code: 'hydroponics',
    label: 'Hydroponics Module',
    icon: '\uD83C\uDF31',
    defaultRoute: '/hydroponics/setup',
    features: ['System Management', 'Nutrient Solutions', 'Growing Beds', 'Climate Control', 'Harvest Tracking'],
    tables: [],
  },
};

export function resolveModuleCode(nameOrCode: string): string {
  const lower = nameOrCode.toLowerCase();
  if (MODULE_REGISTRY[lower]) return lower;
  for (const code of Object.keys(MODULE_REGISTRY)) {
    if (lower.includes(code)) return code;
  }
  return 'default';
}

export function getModuleCodeForTable(fullTableName: string): string {
  const parts = fullTableName.split('.');
  const tableName = parts[parts.length - 1];
  for (const [code, entry] of Object.entries(MODULE_REGISTRY)) {
    if (entry.tables.includes(tableName)) return code;
  }
  return 'other';
}

export interface RoleColor {
  value: string;
  label: string;
}

export const ROLE_COLORS: RoleColor[] = [
  { value: '#6366F1', label: 'Indigo' },
  { value: '#8B5CF6', label: 'Purple' },
  { value: '#EC4899', label: 'Pink' },
  { value: '#EF4444', label: 'Red' },
  { value: '#F97316', label: 'Orange' },
  { value: '#EAB308', label: 'Yellow' },
  { value: '#22C55E', label: 'Green' },
  { value: '#14B8A6', label: 'Teal' },
  { value: '#0EA5E9', label: 'Sky' },
  { value: '#6B7280', label: 'Gray' },
];
