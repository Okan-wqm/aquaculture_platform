/**
 * HR-module pages (/hr).
 *
 * The same pages serve the Team area of each module workspace and the
 * Company › Workforce area, under one id each. The "coming soon" routes the
 * HR module mounts are listed too, marked `planned`, so no routed page is
 * left unreachable; the rail renders them as planned.
 */
import type { ConsoleRole, NavPageDef } from '../types';

/**
 * The roles PayrollPage admits (`isAuthorised`, SEC-003: salary, bank and tax
 * data); anyone else gets its "Access Restricted" view, so the nav does not
 * offer it to them.
 */
export const PAYROLL_ROLES: readonly ConsoleRole[] = ['TENANT_ADMIN', 'MODULE_MANAGER'];

export const HR_PAGES = {
  dashboard: {
    id: 'hr-dashboard',
    labelKey: 'nav.page.hrDashboard',
    path: '/hr',
    matchPaths: ['/hr/dashboard'],
  },
  today: { id: 'hr-today', labelKey: 'nav.page.todayAttendance', path: '/hr/today' },
  // The people list: every module workspace's Team list and Company's workforce
  // list are this one entry (the page narrows itself to the workspace's module).
  employees: {
    id: 'hr-employees',
    labelKey: 'nav.page.teamList',
    path: '/hr/employees',
    matchPaths: [
      '/hr/employees/new',
      '/hr/employees/:employeeId',
      '/hr/employees/:employeeId/edit',
    ],
  },
  departments: { id: 'hr-departments', labelKey: 'nav.departments', path: '/hr/departments' },
  organizationChart: {
    id: 'hr-organization-chart',
    labelKey: 'nav.page.organizationChart',
    path: '/hr/organization',
  },
  // The weekly plan; two older URLs render the same page.
  scheduling: {
    id: 'hr-scheduling',
    labelKey: 'nav.page.shiftSchedule',
    path: '/hr/scheduling',
    matchPaths: ['/hr/scheduling/weekly', '/hr/attendance/schedules'],
  },
  teamOverview: {
    id: 'hr-team-overview',
    labelKey: 'nav.page.teamOverview',
    path: '/hr/scheduling/team-overview',
  },
  schedulingSettings: {
    id: 'hr-scheduling-settings',
    labelKey: 'nav.page.schedulingSettings',
    path: '/hr/scheduling/settings',
  },
  attendance: { id: 'hr-attendance', labelKey: 'nav.attendance', path: '/hr/attendance' },
  leaves: {
    id: 'hr-leaves',
    labelKey: 'nav.page.leaveRequests',
    path: '/hr/leaves',
    badge: 'leavePending',
  },
  // Offshore crew assignments: not module-scoped, so Company lists it alone.
  crew: { id: 'hr-crew', labelKey: 'nav.page.crewAssignments', path: '/hr/crew' },
  rotations: {
    id: 'hr-rotations',
    labelKey: 'nav.page.offshoreRotations',
    path: '/hr/crew/rotations',
  },
  training: { id: 'hr-training', labelKey: 'nav.training', path: '/hr/training' },
  certifications: {
    id: 'hr-certifications',
    labelKey: 'nav.page.certifications',
    path: '/hr/training/certifications',
  },
  performance: { id: 'hr-performance', labelKey: 'nav.performance', path: '/hr/performance' },
  payroll: {
    id: 'hr-payroll',
    labelKey: 'nav.payroll',
    path: '/hr/payroll',
    requiredRoles: PAYROLL_ROLES,
  },
  analytics: { id: 'hr-analytics', labelKey: 'nav.page.hrAnalytics', path: '/hr/analytics' },
} satisfies Record<string, NavPageDef>;

/** The HR module's routed "coming soon" placeholders, in the module's route order. */
export const HR_PLANNED_PAGES = {
  shifts: {
    id: 'hr-planned-shifts',
    labelKey: 'nav.page.shiftManagement',
    path: '/hr/attendance/shifts',
    status: 'planned',
  },
  leaveCalendar: {
    id: 'hr-planned-leave-calendar',
    labelKey: 'nav.page.leaveCalendar',
    path: '/hr/leaves/calendar',
    status: 'planned',
  },
  leaveBalances: {
    id: 'hr-planned-leave-balances',
    labelKey: 'nav.page.leaveBalances',
    path: '/hr/leaves/balances',
    status: 'planned',
  },
  leaveTypes: {
    id: 'hr-planned-leave-types',
    labelKey: 'nav.page.leaveTypes',
    path: '/hr/leaves/types',
    status: 'planned',
  },
  payslips: {
    id: 'hr-planned-payslips',
    labelKey: 'nav.page.payslips',
    path: '/hr/payroll/payslips',
    status: 'planned',
  },
  payrollReports: {
    id: 'hr-planned-payroll-reports',
    labelKey: 'nav.page.payrollReports',
    path: '/hr/payroll/reports',
    status: 'planned',
  },
  goals: {
    id: 'hr-planned-goals',
    labelKey: 'nav.page.goalsOkrs',
    path: '/hr/performance/goals',
    status: 'planned',
  },
  reviews: {
    id: 'hr-planned-reviews',
    labelKey: 'nav.page.reviewCycles',
    path: '/hr/performance/reviews',
    status: 'planned',
  },
  courses: {
    id: 'hr-planned-courses',
    labelKey: 'nav.page.trainingCourses',
    path: '/hr/training/courses',
    status: 'planned',
  },
  compliance: {
    id: 'hr-planned-compliance',
    labelKey: 'nav.page.complianceDashboard',
    path: '/hr/training/compliance',
    status: 'planned',
  },
  workAreas: {
    id: 'hr-planned-work-areas',
    labelKey: 'nav.page.workAreas',
    path: '/hr/crew/work-areas',
    status: 'planned',
  },
  transport: {
    id: 'hr-planned-transport',
    labelKey: 'nav.page.transportSchedule',
    path: '/hr/crew/transport',
    status: 'planned',
  },
  positions: {
    id: 'hr-planned-positions',
    labelKey: 'nav.page.positions',
    path: '/hr/organization/positions',
    status: 'planned',
  },
  reports: {
    id: 'hr-planned-reports',
    labelKey: 'nav.page.hrReports',
    path: '/hr/reports',
    status: 'planned',
  },
  settings: {
    id: 'hr-planned-settings',
    labelKey: 'nav.page.hrSettings',
    path: '/hr/settings',
    status: 'planned',
  },
} satisfies Record<string, NavPageDef>;
