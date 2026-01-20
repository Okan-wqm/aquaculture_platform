/**
 * GraphQL queries for Equipment data from farm-service
 */

export const EQUIPMENT_LIST_QUERY = `
  query EquipmentList($filter: EquipmentFilterInput, $pagination: PaginationInput) {
    equipmentList(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        code
        description
        status
        manufacturer
        model
        isTank
        volume
        isVisibleInSensor
        specifications
        equipmentType {
          id
          name
          code
          category
          icon
        }
        department {
          id
          name
        }
      }
      total
      page
      limit
    }
  }
`;

export const EQUIPMENT_TYPES_QUERY = `
  query EquipmentTypes($filter: EquipmentTypeFilterInput) {
    equipmentTypes(filter: $filter) {
      id
      name
      code
      description
      category
      icon
      isActive
      sortOrder
    }
  }
`;

export const EQUIPMENT_BY_ID_QUERY = `
  query Equipment($id: ID!, $includeRelations: Boolean) {
    equipment(id: $id, includeRelations: $includeRelations) {
      id
      name
      code
      description
      status
      manufacturer
      model
      serialNumber
      isTank
      volume
      specifications
      location
      equipmentType {
        id
        name
        code
        category
        icon
        specificationSchema
      }
      department {
        id
        name
        code
      }
      childEquipment {
        id
        name
        code
        status
      }
    }
  }
`;

export const EQUIPMENT_BY_DEPARTMENT_QUERY = `
  query EquipmentByDepartment($departmentId: ID!) {
    equipmentByDepartment(departmentId: $departmentId) {
      id
      name
      code
      status
      equipmentType {
        id
        name
        code
        category
        icon
      }
    }
  }
`;
