/**
 * GraphQL queries and mutations for Automation Programs
 *
 * Shared between AutomationProgramsPage and AutomationProgramEditorPage.
 */

// ============================================================================
// Queries
// ============================================================================

export const AUTOMATION_PROGRAMS_QUERY = `
  query AutomationPrograms($filter: ProgramFilterInput, $page: Int, $limit: Int) {
    automationPrograms(filter: $filter, page: $page, limit: $limit) {
      items {
        id
        programCode
        programName
        description
        version
        programType
        status
        stepCount
        transitionCount
        variableCount
        createdAt
        updatedAt
        approvedAt
        approvedBy
      }
      total page limit totalPages hasNextPage hasPreviousPage
    }
    automationProgramStats {
      total
      byStatus {
        status
        count
      }
      byType {
        type
        count
      }
    }
  }
`;

export const AUTOMATION_PROGRAM_QUERY = `
  query AutomationProgram($id: ID!) {
    automationProgram(id: $id) {
      id
      programCode
      programName
      description
      version
      programType
      status
      executionMode
      structuredTextCode
      deployTarget
      targetPlcAddress
      targetPlcPort
      targetPlcModel
      targetPlcProtocol
      approvedBy
      createdAt
      updatedAt
    }
    programSteps(programId: $id) {
      id
      stepCode
      stepName
      stepOrder
      stepType
      description
    }
    programVariables(programId: $id) {
      id
      varName
      dataType
      initialValue
      scope
      description
      ioTagName
      ioConfigId
    }
    programTransitions(programId: $id) {
      id
      transitionCode
      fromStepId
      toStepId
      conditionExpression
      priority
    }
  }
`;

/**
 * Lean ST-editor hydration query: only Structured Text programs, with their
 * source. Kept separate from AUTOMATION_PROGRAMS_QUERY so the list page's
 * payload stays small while the editor gets the code bodies in one round trip.
 */
export const ST_PROGRAMS_QUERY = `
  query StPrograms($limit: Int) {
    automationPrograms(filter: { programType: ST }, limit: $limit) {
      items {
        id
        programCode
        programName
        status
        structuredTextCode
        updatedAt
      }
    }
  }
`;

export const DEPLOYMENT_HISTORY_QUERY = `
  query DeploymentHistory($deviceId: ID, $page: Int, $limit: Int) {
    deploymentHistory(deviceId: $deviceId, page: $page, limit: $limit) {
      items {
        id
        programId
        deviceId
        commandId
        status
        version
        deployedBy
        deployedAt
        completedAt
        edgeAckAt
        errorMessage
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
`;

// ============================================================================
// Program CRUD Mutations
// ============================================================================

export const CREATE_PROGRAM_MUTATION = `
  mutation CreateAutomationProgram($input: CreateProgramInput!) {
    createAutomationProgram(input: $input) {
      id
      programCode
      structuredTextCode
    }
  }
`;

export const UPDATE_PROGRAM_MUTATION = `
  mutation UpdateAutomationProgram($id: ID!, $input: UpdateProgramInput!) {
    updateAutomationProgram(id: $id, input: $input) {
      id
      programName
      structuredTextCode
    }
  }
`;

export const DELETE_PROGRAM_MUTATION = `
  mutation DeleteAutomationProgram($id: ID!) {
    deleteAutomationProgram(id: $id)
  }
`;

export const CLONE_PROGRAM_MUTATION = `
  mutation CloneAutomationProgram($id: ID!, $newCode: String!) {
    cloneAutomationProgram(id: $id, newCode: $newCode) {
      id
      programCode
    }
  }
`;

export const ARCHIVE_PROGRAM_MUTATION = `
  mutation ArchiveProgram($id: ID!) {
    archiveProgram(id: $id) {
      id
      status
    }
  }
`;

// ============================================================================
// Workflow Mutations
// ============================================================================

export const SUBMIT_FOR_REVIEW_MUTATION = `
  mutation SubmitProgramForReview($id: ID!) {
    submitProgramForReview(id: $id) {
      id
      status
    }
  }
`;

export const APPROVE_PROGRAM_MUTATION = `
  mutation ApproveProgram($id: ID!) {
    approveProgram(id: $id) {
      id
      status
      approvedAt
      approvedBy
    }
  }
`;

export const REJECT_PROGRAM_MUTATION = `
  mutation RejectProgram($id: ID!, $reason: String!) {
    rejectProgram(id: $id, reason: $reason) {
      id
      status
      updatedAt
    }
  }
`;

export const DEPLOY_PROGRAM_MUTATION = `
  mutation DeployProgram($input: DeployProgramInput!) {
    deployProgram(input: $input) {
      success
      programId
      deviceId
      error
    }
  }
`;

// ============================================================================
// Step Mutations
// ============================================================================

export const ADD_STEP_MUTATION = `
  mutation AddProgramStep($input: CreateStepInput!) {
    addProgramStep(input: $input) {
      id
      stepName
    }
  }
`;

export const REMOVE_STEP_MUTATION = `
  mutation RemoveProgramStep($id: ID!) {
    removeProgramStep(id: $id)
  }
`;

// ============================================================================
// Variable Mutations
// ============================================================================

export const ADD_VARIABLE_MUTATION = `
  mutation AddProgramVariable($input: CreateVariableInput!) {
    addProgramVariable(input: $input) {
      id
      varName
      ioTagName
      ioConfigId
    }
  }
`;

export const REMOVE_VARIABLE_MUTATION = `
  mutation RemoveProgramVariable($id: ID!) {
    removeProgramVariable(id: $id)
  }
`;

export const SYNC_PROGRAM_VARIABLES_MUTATION = `
  mutation SyncProgramVariables($input: SyncProgramVariablesInput!) {
    syncProgramVariables(input: $input) {
      added
      removed
      updated
      unchanged
    }
  }
`;

// ============================================================================
// Transition Mutations
// ============================================================================

export const ADD_TRANSITION_MUTATION = `
  mutation AddProgramTransition($input: CreateTransitionInput!) {
    addProgramTransition(input: $input) {
      id
      transitionCode
    }
  }
`;

export const REMOVE_TRANSITION_MUTATION = `
  mutation RemoveProgramTransition($id: ID!) {
    removeProgramTransition(id: $id)
  }
`;

// ============================================================================
// Validation
// ============================================================================

// validateStructuredText resolver is in automation.resolver.ts (sensor-service).
// Requires TENANT_ADMIN or MODULE_MANAGER role.
export const VALIDATE_ST_MUTATION = `
  mutation ValidateST($code: String!) {
    validateStructuredText(code: $code) {
      valid
      errors { line column severity message code }
      warnings { line column severity message code }
      infos { line column severity message code }
      parsedSymbols
    }
  }
`;
