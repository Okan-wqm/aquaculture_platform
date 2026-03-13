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
    [ProgramStatus.DRAFT]: 'bg-gray-100 text-gray-700',
    [ProgramStatus.PENDING_REVIEW]: 'bg-yellow-100 text-yellow-700',
    [ProgramStatus.APPROVED]: 'bg-blue-100 text-blue-700',
    [ProgramStatus.DEPLOYING]: 'bg-orange-100 text-orange-700',
    [ProgramStatus.DEPLOYED]: 'bg-green-100 text-green-700',
    [ProgramStatus.ARCHIVED]: 'bg-gray-100 text-gray-500',
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
