/**
 * Gateway API Test Utilities
 *
 * Provides properly typed mock creators for testing guards, interceptors, and middleware.
 * These utilities ensure type safety in tests while maintaining flexibility.
 */

import { ExecutionContext, CallHandler, ArgumentsHost } from '@nestjs/common';
import { HttpArgumentsHost } from '@nestjs/common/interfaces';
import { GqlContextType } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { Observable, of } from 'rxjs';

/**
 * Mock request with typed properties
 */
export interface MockRequest extends Partial<Request> {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string>;
  params: Record<string, string>;
  body: Record<string, unknown>;
  path: string;
  method: string;
  ip: string;
  user?: {
    sub: string;
    tenantId: string;
    roles: string[];
    permissions?: string[];
    email?: string;
  };
  tenantId?: string;
  tenantContext?: {
    tenantId: string;
    tenantName?: string;
    isActive: boolean;
  };
  correlationId?: string;
  startTime?: number;
}

/**
 * Mock response with typed methods
 */
export interface MockResponse extends Partial<Response> {
  status: jest.Mock<MockResponse, [number]>;
  json: jest.Mock<MockResponse, [unknown]>;
  send: jest.Mock<MockResponse, [unknown]>;
  setHeader: jest.Mock<MockResponse, [string, string | number]>;
  getHeader: jest.Mock<string | undefined, [string]>;
  header: jest.Mock<MockResponse, [string, string]>;
  headers: Record<string, string>;
}

/**
 * Mock HTTP arguments host
 */
export interface MockHttpArgumentsHost extends HttpArgumentsHost {
  getRequest: <T = MockRequest>() => T;
  getResponse: <T = MockResponse>() => T;
  getNext: <T = () => void>() => T;
}

/**
 * Create a properly typed mock request
 */
export function createMockRequest(overrides: Partial<MockRequest> = {}): MockRequest {
  return {
    headers: {},
    query: {},
    params: {},
    body: {},
    path: '/api/v1/test',
    method: 'GET',
    ip: '127.0.0.1',
    ...overrides,
  };
}

/**
 * Create a properly typed mock response
 */
export function createMockResponse(overrides: Partial<MockResponse> = {}): MockResponse {
  const response: MockResponse = {
    status: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [number]>,
    json: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [unknown]>,
    send: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [unknown]>,
    setHeader: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [string, string | number]>,
    getHeader: jest.fn().mockReturnValue(undefined) as jest.Mock<string | undefined, [string]>,
    header: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [string, string]>,
    headers: {},
    ...overrides,
  };
  return response;
}

/**
 * Create a properly typed mock execution context for HTTP requests
 */
export function createMockExecutionContext(options: {
  request?: Partial<MockRequest>;
  response?: Partial<MockResponse>;
  handler?: jest.Mock;
  classRef?: jest.Mock;
  contextType?: 'http' | 'graphql' | 'ws' | 'rpc';
} = {}): ExecutionContext {
  const {
    request: requestOverrides,
    response: responseOverrides,
    handler = jest.fn(),
    classRef = jest.fn(),
    contextType = 'http',
  } = options;

  const mockRequest = createMockRequest(requestOverrides);
  const mockResponse = createMockResponse(responseOverrides);

  const mockHttpHost: MockHttpArgumentsHost = {
    getRequest: <T = MockRequest>(): T => mockRequest as T,
    getResponse: <T = MockResponse>(): T => mockResponse as T,
    getNext: <T = () => void>(): T => jest.fn() as T,
  };

  return {
    switchToHttp: () => mockHttpHost,
    switchToWs: () => ({
      getClient: jest.fn(),
      getData: jest.fn(),
      getPattern: jest.fn(),
    }),
    switchToRpc: () => ({
      getContext: jest.fn(),
      getData: jest.fn(),
    }),
    getHandler: () => handler,
    getClass: () => classRef,
    getType: <T extends string = GqlContextType>(): T => contextType as T,
    getArgs: () => [mockRequest, mockResponse, jest.fn(), {}],
    getArgByIndex: (index: number) => [mockRequest, mockResponse, jest.fn(), {}][index],
  } as ExecutionContext;
}

/**
 * Create a mock execution context for GraphQL requests
 */
export function createMockGqlExecutionContext(options: {
  request?: Partial<MockRequest>;
  response?: Partial<MockResponse>;
  info?: {
    fieldName: string;
    operation?: { name?: { value: string }; operation: string };
  };
  args?: Record<string, unknown>;
} = {}): ExecutionContext {
  const { request: requestOverrides, response: responseOverrides, info, args = {} } = options;

  const mockRequest = createMockRequest(requestOverrides);
  const mockResponse = createMockResponse(responseOverrides);

  const gqlContext = {
    req: mockRequest,
    res: mockResponse,
  };

  // Mock the GqlExecutionContext.create static method behavior
  const context = createMockExecutionContext({
    request: requestOverrides,
    response: responseOverrides,
    contextType: 'graphql',
  });

  // Add GraphQL-specific context
  const originalSwitchToHttp = context.switchToHttp.bind(context);
  Object.assign(context, {
    switchToHttp: () => ({
      ...originalSwitchToHttp(),
      getRequest: () => mockRequest,
      getResponse: () => mockResponse,
    }),
  });

  // Store info and args for GqlExecutionContext.create to access
  (context as unknown as { __gqlContext: unknown; __gqlInfo: unknown; __gqlArgs: unknown }).__gqlContext = gqlContext;
  (context as unknown as { __gqlInfo: unknown }).__gqlInfo = info ?? { fieldName: 'testQuery' };
  (context as unknown as { __gqlArgs: unknown }).__gqlArgs = args;

  return context;
}

/**
 * Create a mock call handler for interceptors
 */
export function createMockCallHandler<T = unknown>(returnValue?: T): CallHandler<T> {
  return {
    handle: () => of(returnValue) as Observable<T>,
  };
}

/**
 * Create a mock arguments host for exception filters
 */
export function createMockArgumentsHost(options: {
  request?: Partial<MockRequest>;
  response?: Partial<MockResponse>;
  contextType?: 'http' | 'graphql' | 'ws' | 'rpc';
} = {}): ArgumentsHost {
  const { request: requestOverrides, response: responseOverrides, contextType = 'http' } = options;

  const mockRequest = createMockRequest(requestOverrides);
  const mockResponse = createMockResponse(responseOverrides);

  const mockHttpHost: MockHttpArgumentsHost = {
    getRequest: <T = MockRequest>(): T => mockRequest as T,
    getResponse: <T = MockResponse>(): T => mockResponse as T,
    getNext: <T = () => void>(): T => jest.fn() as T,
  };

  return {
    switchToHttp: () => mockHttpHost,
    switchToWs: () => ({
      getClient: jest.fn(),
      getData: jest.fn(),
      getPattern: jest.fn(),
    }),
    switchToRpc: () => ({
      getContext: jest.fn(),
      getData: jest.fn(),
    }),
    getType: <T extends string = string>(): T => contextType as T,
    getArgs: () => [mockRequest, mockResponse, jest.fn()],
    getArgByIndex: (index: number) => [mockRequest, mockResponse, jest.fn()][index],
  } as ArgumentsHost;
}

/**
 * Extract response body from mock response
 */
export function getResponseBody(mockResponse: MockResponse): unknown {
  const jsonCalls = mockResponse.json.mock.calls;
  if (jsonCalls.length > 0) {
    return jsonCalls[jsonCalls.length - 1][0];
  }
  return undefined;
}

/**
 * Extract response status from mock response
 */
export function getResponseStatus(mockResponse: MockResponse): number | undefined {
  const statusCalls = mockResponse.status.mock.calls;
  if (statusCalls.length > 0) {
    return statusCalls[statusCalls.length - 1][0];
  }
  return undefined;
}

/**
 * Create mock JWT payload
 */
export function createMockJwtPayload(overrides: Partial<{
  sub: string;
  tenantId: string;
  roles: string[];
  permissions: string[];
  email: string;
  type: 'access' | 'refresh';
  iat: number;
  exp: number;
  iss: string;
  aud: string | string[];
  jti: string;
}> = {}): {
  sub: string;
  tenantId: string;
  roles: string[];
  permissions?: string[];
  email?: string;
  type: 'access' | 'refresh';
  iat: number;
  exp: number;
  iss?: string;
  aud?: string | string[];
  jti?: string;
} {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'user-123',
    tenantId: 'tenant-123',
    roles: ['user'],
    type: 'access',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

/**
 * Create mock tenant context
 */
export function createMockTenantContext(overrides: Partial<{
  tenantId: string;
  tenantName: string;
  plan: string;
  modules: string[];
  isActive: boolean;
}> = {}): {
  tenantId: string;
  tenantName?: string;
  plan?: string;
  modules?: string[];
  isActive: boolean;
} {
  return {
    tenantId: 'tenant-123',
    tenantName: 'Test Tenant',
    plan: 'professional',
    modules: ['farm', 'sensor', 'alert'],
    isActive: true,
    ...overrides,
  };
}
