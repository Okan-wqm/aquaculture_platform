// GraphQL queries and mutations for Unified Tags

export const UNIFIED_TAG_FIELDS = `
  id
  tenantId
  fqn
  localName
  displayName
  description
  ioType
  dataType
  direction
  engUnit
  engMin
  engMax
  alarmHH
  alarmH
  alarmL
  alarmLL
  deadband
  source
  hierarchy
  status
  createdAt
  updatedAt
`;

export const GET_UNIFIED_TAG = `
  query GetUnifiedTag($id: ID!) {
    unifiedTag(id: $id) {
      ${UNIFIED_TAG_FIELDS}
    }
  }
`;

export const GET_UNIFIED_TAGS = `
  query GetUnifiedTags($filter: TagFilterInput, $pagination: ProcessPaginationInput) {
    unifiedTags(filter: $filter, pagination: $pagination) {
      items {
        ${UNIFIED_TAG_FIELDS}
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

export const SEARCH_TAGS = `
  query SearchTags($query: String!, $limit: Int) {
    searchTags(query: $query, limit: $limit) {
      ${UNIFIED_TAG_FIELDS}
    }
  }
`;

export const CREATE_UNIFIED_TAG = `
  mutation CreateUnifiedTag($input: CreateTagInput!) {
    createUnifiedTag(input: $input) {
      ${UNIFIED_TAG_FIELDS}
    }
  }
`;

export const UPDATE_UNIFIED_TAG = `
  mutation UpdateUnifiedTag($input: UpdateTagInput!) {
    updateUnifiedTag(input: $input) {
      ${UNIFIED_TAG_FIELDS}
    }
  }
`;

export const RETIRE_UNIFIED_TAG = `
  mutation RetireUnifiedTag($id: ID!) {
    retireUnifiedTag(id: $id) {
      ${UNIFIED_TAG_FIELDS}
    }
  }
`;

export const DELETE_UNIFIED_TAG = `
  mutation DeleteUnifiedTag($id: ID!) {
    deleteUnifiedTag(id: $id)
  }
`;

export const DISCOVER_TAGS = `
  mutation DiscoverTags($deviceId: ID!) {
    discoverTags(deviceId: $deviceId) {
      success
      message
      discoveredCount
      createdCount
      tags {
        ${UNIFIED_TAG_FIELDS}
      }
    }
  }
`;

export const AUTO_BIND_TAGS = `
  mutation AutoBindTags($processId: ID!, $deviceId: ID!) {
    autoBindTags(processId: $processId, deviceId: $deviceId) {
      success
      message
      discoveredCount
      createdCount
      tags {
        ${UNIFIED_TAG_FIELDS}
      }
    }
  }
`;
