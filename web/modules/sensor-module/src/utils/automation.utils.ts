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
  DRAFT = 'draft',
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  DEPLOYING = 'deploying',
  DEPLOYED = 'deployed',
  ARCHIVED = 'archived',
}

export enum ProgramType {
  SFC = 'sfc',
  FBD = 'fbd',
  ST = 'st',
  LD = 'ld',
}

// ============================================================================
// Status Helpers
// ============================================================================

export const getStatusColor = (status: ProgramStatus): string => {
  const colors: Record<ProgramStatus, string> = {
    [ProgramStatus.DRAFT]: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
    [ProgramStatus.PENDING_REVIEW]: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
    [ProgramStatus.APPROVED]: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    [ProgramStatus.DEPLOYING]: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
    [ProgramStatus.DEPLOYED]: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
    [ProgramStatus.ARCHIVED]: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
  };
  return colors[status] || colors[ProgramStatus.DRAFT];
};

export const getStatusText = (status: ProgramStatus): string => {
  const texts: Record<ProgramStatus, string> = {
    [ProgramStatus.DRAFT]: 'Taslak',
    [ProgramStatus.PENDING_REVIEW]: 'Inceleniyor',
    [ProgramStatus.APPROVED]: 'Onaylandi',
    [ProgramStatus.DEPLOYING]: 'Yukleniyor',
    [ProgramStatus.DEPLOYED]: 'Devrede',
    [ProgramStatus.ARCHIVED]: 'Arsivlendi',
  };
  return texts[status] || status;
};

export const getProgramTypeText = (type: ProgramType): string => {
  const texts: Record<ProgramType, string> = {
    [ProgramType.SFC]: 'SFC',
    [ProgramType.LD]: 'Ladder',
    [ProgramType.FBD]: 'FBD',
    [ProgramType.ST]: 'ST',
  };
  return texts[type] || type;
};
