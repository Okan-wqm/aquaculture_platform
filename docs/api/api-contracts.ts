/**
 * API Contract Definitions for Aquaculture Platform
 *
 * This file defines the standard API contract format for all endpoints.
 * Use these patterns for consistent API design across all services.
 */

// ============================================================================
// Standard Response Formats
// ============================================================================

/**
 * Standard Success Response
 * All successful API responses should follow this format
 */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta?: {
    timestamp: string;
    requestId?: string;
    pagination?: PaginationMeta;
  };
}

/**
 * Standard Error Response
 * All error responses should follow this format
 */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    timestamp: string;
    path?: string;
    requestId?: string;
  };
}

/**
 * Pagination Metadata
 */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

/**
 * Paginated Response
 */
export interface PaginatedResponse<T> extends ApiSuccessResponse<T[]> {
  meta: {
    timestamp: string;
    requestId?: string;
    pagination: PaginationMeta;
  };
}

// ============================================================================
// Standard Query Parameters
// ============================================================================

/**
 * Standard Pagination Query Parameters
 */
export interface PaginationQuery {
  page?: number;      // Page number (1-based), default: 1
  limit?: number;     // Items per page, default: 20, max: 100
}

/**
 * Standard Sort Query Parameters
 */
export interface SortQuery {
  sortBy?: string;    // Field to sort by
  sortOrder?: 'asc' | 'desc';  // Sort direction, default: 'desc'
}

/**
 * Standard Filter Query Parameters
 */
export interface FilterQuery {
  search?: string;    // Search term for text fields
  startDate?: string; // ISO date string
  endDate?: string;   // ISO date string
  status?: string;    // Filter by status
}

/**
 * Combined Query Parameters
 */
export interface StandardQuery extends PaginationQuery, SortQuery, FilterQuery {}

// ============================================================================
// Authentication Headers
// ============================================================================

/**
 * Required Authentication Headers
 */
export interface AuthHeaders {
  'Authorization': string;        // Bearer <token>
  'X-Tenant-ID': string;         // Tenant identifier
}

/**
 * Optional Headers
 */
export interface OptionalHeaders {
  'X-Request-ID'?: string;       // Request correlation ID
  'X-Idempotency-Key'?: string;  // For idempotent POST/PUT requests
  'Accept-Language'?: string;    // Preferred language
}

// ============================================================================
// API Contract Examples
// ============================================================================

/**
 * Example: User API Contracts
 */
export namespace UserApi {
  // GET /api/users
  export interface ListUsersRequest extends StandardQuery {
    role?: string;
    isActive?: boolean;
  }

  export interface ListUsersResponse extends PaginatedResponse<UserDto> {}

  // GET /api/users/:id
  export interface GetUserResponse extends ApiSuccessResponse<UserDto> {}

  // POST /api/users
  export interface CreateUserRequest {
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    password?: string;
    sendInvite?: boolean;
  }

  export interface CreateUserResponse extends ApiSuccessResponse<UserDto> {}

  // PATCH /api/users/:id
  export interface UpdateUserRequest {
    firstName?: string;
    lastName?: string;
    role?: string;
    isActive?: boolean;
  }

  export interface UpdateUserResponse extends ApiSuccessResponse<UserDto> {}

  // DELETE /api/users/:id
  export interface DeleteUserResponse extends ApiSuccessResponse<{ deleted: boolean }> {}
}

/**
 * Example: Subscription API Contracts
 */
export namespace SubscriptionApi {
  // GET /api/subscriptions
  export interface ListSubscriptionsRequest extends StandardQuery {
    status?: string[];
    planTier?: string[];
    billingCycle?: string[];
  }

  export interface ListSubscriptionsResponse extends PaginatedResponse<SubscriptionDto> {}

  // GET /api/subscriptions/:tenantId
  export interface GetSubscriptionResponse extends ApiSuccessResponse<SubscriptionDto> {}

  // POST /api/subscriptions
  export interface CreateSubscriptionRequest {
    tenantId: string;
    planTier?: string;
    billingCycle?: string;
    modules: ModuleConfig[];
    monthlyTotal: number;
    trialDays?: number;
    discountCode?: string;
  }

  export interface CreateSubscriptionResponse extends ApiSuccessResponse<SubscriptionDto> {}

  // POST /api/subscriptions/:tenantId/change-plan
  export interface ChangePlanRequest {
    currentPlanId: string;
    newPlanId: string;
    newBillingCycle?: string;
    discountCode?: string;
    effectiveImmediately?: boolean;
  }

  export interface ChangePlanResponse extends ApiSuccessResponse<{
    success: boolean;
    isUpgrade: boolean;
    isDowngrade: boolean;
    proratedAmount: number;
    newMonthlyPrice: number;
    effectiveDate: string;
    invoice?: InvoiceDto;
    warnings: string[];
    message: string;
  }> {}

  // POST /api/subscriptions/:tenantId/cancel
  export interface CancelSubscriptionRequest {
    reason: string;
    cancelImmediately?: boolean;
  }

  export interface CancelSubscriptionResponse extends ApiSuccessResponse<{
    success: boolean;
    effectiveDate: string;
    message: string;
  }> {}
}

/**
 * Example: Farm API Contracts
 */
export namespace FarmApi {
  // GET /api/farms
  export interface ListFarmsRequest extends StandardQuery {
    type?: string;
    region?: string;
  }

  export interface ListFarmsResponse extends PaginatedResponse<FarmDto> {}

  // GET /api/farms/:id
  export interface GetFarmResponse extends ApiSuccessResponse<FarmDetailDto> {}

  // POST /api/farms
  export interface CreateFarmRequest {
    name: string;
    type: string;
    address: AddressDto;
    contactInfo: ContactInfoDto;
    capacity?: number;
  }

  export interface CreateFarmResponse extends ApiSuccessResponse<FarmDto> {}

  // GET /api/farms/:farmId/ponds
  export interface ListPondsRequest extends StandardQuery {
    status?: string;
  }

  export interface ListPondsResponse extends PaginatedResponse<PondDto> {}
}

/**
 * Example: Sensor API Contracts
 */
export namespace SensorApi {
  // GET /api/sensors
  export interface ListSensorsRequest extends StandardQuery {
    status?: string;
    type?: string;
    farmId?: string;
    pondId?: string;
  }

  export interface ListSensorsResponse extends PaginatedResponse<SensorDto> {}

  // GET /api/sensors/:id/readings
  export interface GetSensorReadingsRequest {
    startDate: string;
    endDate: string;
    interval?: string;  // '1m', '5m', '1h', '1d'
    aggregation?: 'avg' | 'min' | 'max' | 'sum';
  }

  export interface GetSensorReadingsResponse extends ApiSuccessResponse<{
    sensorId: string;
    readings: SensorReadingDto[];
    statistics: {
      min: number;
      max: number;
      avg: number;
      count: number;
    };
  }> {}

  // POST /api/sensors/:id/data
  export interface PostSensorDataRequest {
    readings: Array<{
      timestamp: string;
      value: number;
      unit: string;
    }>;
  }

  export interface PostSensorDataResponse extends ApiSuccessResponse<{
    received: number;
    stored: number;
    errors?: string[];
  }> {}
}

// ============================================================================
// DTO Definitions (Simplified examples)
// ============================================================================

interface UserDto {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SubscriptionDto {
  id: string;
  tenantId: string;
  planTier: string;
  planName: string;
  status: string;
  billingCycle: string;
  monthlyPrice: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  autoRenew: boolean;
  trialEndDate?: string;
  createdAt: string;
}

interface ModuleConfig {
  moduleId: string;
  moduleCode: string;
  quantities: Record<string, number>;
  subtotal: number;
}

interface InvoiceDto {
  id: string;
  amount: number;
  dueDate: string;
}

interface FarmDto {
  id: string;
  name: string;
  type: string;
  status: string;
  createdAt: string;
}

interface FarmDetailDto extends FarmDto {
  address: AddressDto;
  contactInfo: ContactInfoDto;
  ponds: PondDto[];
  statistics: FarmStatistics;
}

interface AddressDto {
  street: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
}

interface ContactInfoDto {
  phone?: string;
  email?: string;
  contactPerson?: string;
}

interface PondDto {
  id: string;
  name: string;
  type: string;
  capacity: number;
  currentStock: number;
  status: string;
}

interface FarmStatistics {
  totalPonds: number;
  activePonds: number;
  totalCapacity: number;
  currentStock: number;
}

interface SensorDto {
  id: string;
  name: string;
  type: string;
  status: string;
  lastReading?: {
    value: number;
    unit: string;
    timestamp: string;
  };
}

interface SensorReadingDto {
  timestamp: string;
  value: number;
  unit: string;
}
