/**
 * Shared Automation Utilities
 *
 * Enums, status helpers, and type utilities shared between
 * AutomationProgramsPage and AutomationProgramEditorPage.
 */

// ============================================================================
// Enums
// ============================================================================

export enum ProgramStatus {
  DRAFT = 'DRAFT',
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  DEPLOYING = 'DEPLOYING',
  DEPLOYED = 'DEPLOYED',
  ARCHIVED = 'ARCHIVED',
}

export enum ProgramType {
  ST = 'ST',
}

// ============================================================================
// Status Helpers
// ============================================================================

export const getStatusColor = (status: ProgramStatus): string => {
  const colors: Record<ProgramStatus, string> = {
    [ProgramStatus.DRAFT]: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
    [ProgramStatus.PENDING_REVIEW]:
      'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
    [ProgramStatus.APPROVED]: 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300',
    [ProgramStatus.DEPLOYING]:
      'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
    [ProgramStatus.DEPLOYED]:
      'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300',
    [ProgramStatus.ARCHIVED]: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',
  };
  return colors[status] || colors[ProgramStatus.DRAFT];
};

export const getStatusText = (status: ProgramStatus): string => {
  const texts: Record<ProgramStatus, string> = {
    [ProgramStatus.DRAFT]: 'Draft',
    [ProgramStatus.PENDING_REVIEW]: 'Pending Review',
    [ProgramStatus.APPROVED]: 'Approved',
    [ProgramStatus.DEPLOYING]: 'Deploying',
    [ProgramStatus.DEPLOYED]: 'Deployed',
    [ProgramStatus.ARCHIVED]: 'Archived',
  };
  return texts[status] || status;
};

export const getProgramTypeText = (type: ProgramType): string => {
  const texts: Record<ProgramType, string> = {
    [ProgramType.ST]: 'ST',
  };
  return texts[type] || type;
};
