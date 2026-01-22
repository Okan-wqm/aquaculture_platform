import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiResponse,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiInternalServerErrorResponse,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';

/**
 * Standard API Response Decorators
 *
 * These decorators ensure consistent API documentation across all endpoints.
 */

/**
 * Standard success response wrapper schema
 */
export const ApiSuccessResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    data: { type: 'object' },
    meta: {
      type: 'object',
      properties: {
        timestamp: { type: 'string', format: 'date-time' },
        requestId: { type: 'string' },
      },
    },
  },
};

/**
 * Standard error response schema
 */
export const ApiErrorResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', example: 'ERROR_CODE' },
        message: { type: 'string', example: 'Error description' },
        details: { type: 'object' },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
        requestId: { type: 'string' },
      },
    },
  },
};

/**
 * Standard paginated response schema
 */
export const ApiPaginatedResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    data: { type: 'array', items: { type: 'object' } },
    meta: {
      type: 'object',
      properties: {
        timestamp: { type: 'string', format: 'date-time' },
        requestId: { type: 'string' },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number', example: 1 },
            limit: { type: 'number', example: 20 },
            total: { type: 'number', example: 100 },
            totalPages: { type: 'number', example: 5 },
            hasNext: { type: 'boolean', example: true },
            hasPrevious: { type: 'boolean', example: false },
          },
        },
      },
    },
  },
};

/**
 * Decorator for standard OK response (200)
 */
export function ApiStandardResponse<TModel extends Type>(model: TModel, description?: string) {
  return applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      description: description || 'Successful operation',
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiSuccessResponseSchema as unknown as Type) },
          {
            properties: {
              data: { $ref: getSchemaPath(model) },
            },
          },
        ],
      },
    }),
  );
}

/**
 * Decorator for standard Created response (201)
 */
export function ApiCreatedStandardResponse<TModel extends Type>(model: TModel, description?: string) {
  return applyDecorators(
    ApiExtraModels(model),
    ApiCreatedResponse({
      description: description || 'Resource created successfully',
      schema: {
        allOf: [
          {
            properties: {
              success: { type: 'boolean', example: true },
              data: { $ref: getSchemaPath(model) },
              meta: {
                type: 'object',
                properties: {
                  timestamp: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        ],
      },
    }),
  );
}

/**
 * Decorator for paginated list responses
 */
export function ApiPaginatedResponse<TModel extends Type>(model: TModel, description?: string) {
  return applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      description: description || 'Paginated list retrieved successfully',
      schema: {
        properties: {
          success: { type: 'boolean', example: true },
          data: {
            type: 'array',
            items: { $ref: getSchemaPath(model) },
          },
          meta: {
            type: 'object',
            properties: {
              timestamp: { type: 'string', format: 'date-time' },
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'number', example: 1 },
                  limit: { type: 'number', example: 20 },
                  total: { type: 'number', example: 100 },
                  totalPages: { type: 'number', example: 5 },
                  hasNext: { type: 'boolean' },
                  hasPrevious: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    }),
  );
}

/**
 * Standard error responses decorator
 * Applies common error responses to an endpoint
 */
export function ApiStandardErrors() {
  return applyDecorators(
    ApiBadRequestResponse({
      description: 'Validation failed',
      schema: {
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'VALIDATION_FAILED' },
              message: { type: 'string', example: 'Validation failed for one or more fields' },
              details: {
                type: 'object',
                properties: {
                  fields: {
                    type: 'object',
                    example: { email: ['Invalid email format'] },
                  },
                },
              },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    }),
    ApiUnauthorizedResponse({
      description: 'Authentication required',
      schema: {
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'AUTH_TOKEN_INVALID' },
              message: { type: 'string', example: 'Authentication token is invalid' },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    }),
    ApiForbiddenResponse({
      description: 'Insufficient permissions',
      schema: {
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'AUTH_FORBIDDEN' },
              message: { type: 'string', example: 'You do not have permission to perform this action' },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    }),
    ApiInternalServerErrorResponse({
      description: 'Internal server error',
      schema: {
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'INTERNAL_SERVER_ERROR' },
              message: { type: 'string', example: 'An unexpected error occurred' },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    }),
  );
}

/**
 * Not Found error response decorator
 */
export function ApiNotFoundError(resource: string) {
  return applyDecorators(
    ApiNotFoundResponse({
      description: `${resource} not found`,
      schema: {
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: `${resource.toUpperCase()}_NOT_FOUND` },
              message: { type: 'string', example: `${resource} not found` },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    }),
  );
}

/**
 * Conflict error response decorator
 */
export function ApiConflictError(description: string) {
  return applyDecorators(
    ApiConflictResponse({
      description,
      schema: {
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'CONFLICT' },
              message: { type: 'string', example: description },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    }),
  );
}
