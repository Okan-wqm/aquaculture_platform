/**
 * Policy Enforcer Service Tests
 *
 * Comprehensive test suite for policy enforcement service
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import {
  PolicyEnforcerService,
  AuthorizationContext,
  SubjectContext,
  AuthorizationDecision,
} from '../policy-enforcer.service';
import { OpaClientService, OpaResult } from '../opa-client.service';
import { EventEmitter } from 'events';

describe('PolicyEnforcerService', () => {
  let service: PolicyEnforcerService;
  let opaClient: jest.Mocked<OpaClientService>;

  const createSubject = (overrides: Partial<SubjectContext> = {}): SubjectContext => ({
    id: 'user-123',
    type: 'user',
    tenantId: 'tenant-456',
    roles: ['user'],
    permissions: ['read:farms'],
    ...overrides,
  });

  const createContext = (overrides: Partial<AuthorizationContext> = {}): AuthorizationContext => ({
    subject: createSubject(),
    resource: {
      type: 'farm',
      id: 'farm-789',
      tenantId: 'tenant-456',
    },
    action: {
      name: 'read',
    },
    ...overrides,
  });

  beforeEach(async () => {
    const mockOpaClient = {
      checkHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
      evaluatePolicy: jest.fn().mockResolvedValue({ result: { allow: true } }),
      on: jest.fn(),
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyEnforcerService,
        {
          provide: OpaClientService,
          useValue: mockOpaClient,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                POLICY_AUDIT_LOG: true,
                POLICY_FAIL_OPEN: false,
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<PolicyEnforcerService>(PolicyEnforcerService);
    opaClient = module.get(OpaClientService);

    await service.onModuleInit();
  });

  describe('Module Initialization', () => {
    it('should check OPA health on init', () => {
      expect(opaClient.checkHealth).toHaveBeenCalled();
    });

    it('should subscribe to health change events', () => {
      expect(opaClient.on).toHaveBeenCalledWith('healthChange', expect.any(Function));
    });
  });

  describe('isAuthorized', () => {
    it('should return allowed=true when OPA allows', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allow: true },
        decision_id: 'dec-123',
      });

      const decision = await service.isAuthorized(createContext());

      expect(decision.allowed).toBe(true);
      expect(decision.decisionId).toBe('dec-123');
    });

    it('should return allowed=false when OPA denies', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allow: false, reason: 'Insufficient permissions' },
      });

      const decision = await service.isAuthorized(createContext());

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('Insufficient permissions');
    });

    it('should include evaluation time in decision', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({ result: { allow: true } });

      const decision = await service.isAuthorized(createContext());

      expect(decision.evaluationTime).toBeDefined();
      expect(typeof decision.evaluationTime).toBe('number');
    });

    it('should handle OPA result with "allowed" property', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allowed: true },
      });

      const decision = await service.isAuthorized(createContext());

      expect(decision.allowed).toBe(true);
    });

    it('should include obligations from OPA result', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: {
          allow: true,
          obligations: [
            { type: 'log', action: 'access_logged' },
            { type: 'audit', action: 'sensitive_access' },
          ],
        },
      });

      const decision = await service.isAuthorized(createContext());

      expect(decision.obligations).toHaveLength(2);
      expect(decision.obligations?.[0].type).toBe('log');
    });
  });

  describe('Fallback Policies', () => {
    beforeEach(async () => {
      // Simulate OPA being unavailable
      opaClient.checkHealth.mockResolvedValue({ status: 'unhealthy' } as any);

      const module = await Test.createTestingModule({
        providers: [
          PolicyEnforcerService,
          {
            provide: OpaClientService,
            useValue: {
              checkHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }),
              evaluatePolicy: jest.fn(),
              on: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
            },
          },
        ],
      }).compile();

      service = module.get<PolicyEnforcerService>(PolicyEnforcerService);
      await service.onModuleInit();
    });

    it('should allow system_admin role access', async () => {
      const context = createContext({
        subject: createSubject({ roles: ['system_admin'] }),
      });

      const decision = await service.isAuthorized(context);

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('systemAdmin');
    });

    it('should allow same tenant access', async () => {
      const context = createContext({
        subject: createSubject({ tenantId: 'tenant-123' }),
        resource: { type: 'farm', tenantId: 'tenant-123' },
      });

      const decision = await service.isAuthorized(context);

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('tenantIsolation');
    });

    it('should allow resource owner access', async () => {
      const context = createContext({
        subject: createSubject({ id: 'user-owner' }),
        resource: { type: 'farm', ownerId: 'user-owner' },
      });

      const decision = await service.isAuthorized(context);

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('ownerAccess');
    });

    it('should deny when no fallback policy matches', async () => {
      const context = createContext({
        subject: createSubject({
          id: 'other-user',
          tenantId: 'tenant-A',
          roles: ['user'],
        }),
        resource: {
          type: 'farm',
          tenantId: 'tenant-B',
          ownerId: 'another-user',
        },
      });

      const decision = await service.isAuthorized(context);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('No fallback policy matched');
    });
  });

  describe('enforce', () => {
    it('should not throw when authorized', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allow: true },
      });

      await expect(service.enforce(createContext())).resolves.not.toThrow();
    });

    it('should throw ForbiddenException when not authorized', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allow: false, reason: 'No permission' },
      });

      await expect(service.enforce(createContext())).rejects.toThrow(ForbiddenException);
    });

    it('should include reason in ForbiddenException', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allow: false, reason: 'Custom denial reason' },
      });

      try {
        await service.enforce(createContext());
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        const response = (error as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(response.reason).toBe('Custom denial reason');
      }
    });

    it('should execute obligations when authorized', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: {
          allow: true,
          obligations: [{ type: 'log', action: 'test_action' }],
        },
      });

      // Should not throw and execute obligations
      await expect(service.enforce(createContext())).resolves.not.toThrow();
    });
  });

  describe('canAccessResource', () => {
    it('should return true when resource access is allowed', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allow: true },
      });

      const subject = createSubject();
      const canAccess = await service.canAccessResource(subject, 'farm', 'farm-123', 'read');

      expect(canAccess).toBe(true);
    });

    it('should return false when resource access is denied', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allow: false },
      });

      const subject = createSubject();
      const canAccess = await service.canAccessResource(subject, 'farm', 'farm-123', 'delete');

      expect(canAccess).toBe(false);
    });
  });

  describe('canAccessModule', () => {
    it('should return true when module access is allowed', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({ result: true });

      const subject = createSubject();
      const canAccess = await service.canAccessModule(subject, 'dashboard');

      expect(canAccess).toBe(true);
    });

    it('should return false when module access is denied', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({ result: false });

      const subject = createSubject();
      const canAccess = await service.canAccessModule(subject, 'admin-panel');

      expect(canAccess).toBe(false);
    });

    it('should fallback to checking subject ID when OPA unavailable', async () => {
      // Create service with OPA unavailable
      const module = await Test.createTestingModule({
        providers: [
          PolicyEnforcerService,
          {
            provide: OpaClientService,
            useValue: {
              checkHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }),
              evaluatePolicy: jest.fn(),
              on: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
            },
          },
        ],
      }).compile();

      const localService = module.get<PolicyEnforcerService>(PolicyEnforcerService);
      await localService.onModuleInit();

      const subject = createSubject();
      const canAccess = await localService.canAccessModule(subject, 'dashboard');

      expect(canAccess).toBe(true);
    });
  });

  describe('canAccessTenant', () => {
    it('should allow same tenant access', async () => {
      const subject = createSubject({ tenantId: 'tenant-123' });
      const canAccess = await service.canAccessTenant(subject, 'tenant-123');

      expect(canAccess).toBe(true);
    });

    it('should allow system_admin cross-tenant access', async () => {
      const subject = createSubject({
        tenantId: 'tenant-A',
        roles: ['system_admin'],
      });

      const canAccess = await service.canAccessTenant(subject, 'tenant-B');

      expect(canAccess).toBe(true);
    });

    it('should check OPA for cross-tenant access', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({ result: true });

      const subject = createSubject({
        tenantId: 'tenant-A',
        roles: ['user'],
      });

      await service.canAccessTenant(subject, 'tenant-B');

      expect(opaClient.evaluatePolicy).toHaveBeenCalledWith(
        'aquaculture/authz/tenant_access',
        expect.objectContaining({
          targetTenantId: 'tenant-B',
        }),
      );
    });
  });

  describe('checkDataResidency', () => {
    it('should check data residency with OPA', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({ result: true });

      const subject = createSubject();
      const isCompliant = await service.checkDataResidency(subject, 'eu-west-1', [
        'eu-west-1',
        'eu-central-1',
      ]);

      expect(isCompliant).toBe(true);
      expect(opaClient.evaluatePolicy).toHaveBeenCalledWith(
        'aquaculture/authz/data_residency',
        expect.objectContaining({
          dataLocation: 'eu-west-1',
          allowedRegions: ['eu-west-1', 'eu-central-1'],
        }),
      );
    });

    it('should use fallback when OPA unavailable', async () => {
      const module = await Test.createTestingModule({
        providers: [
          PolicyEnforcerService,
          {
            provide: OpaClientService,
            useValue: {
              checkHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }),
              evaluatePolicy: jest.fn(),
              on: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
            },
          },
        ],
      }).compile();

      const localService = module.get<PolicyEnforcerService>(PolicyEnforcerService);
      await localService.onModuleInit();

      const subject = createSubject();

      // Location in allowed regions
      const isCompliant = await localService.checkDataResidency(subject, 'eu-west-1', [
        'eu-west-1',
        'us-east-1',
      ]);
      expect(isCompliant).toBe(true);

      // Location not in allowed regions
      const isNotCompliant = await localService.checkDataResidency(subject, 'ap-south-1', [
        'eu-west-1',
        'us-east-1',
      ]);
      expect(isNotCompliant).toBe(false);
    });
  });

  describe('isFeatureEnabled', () => {
    it('should check feature with OPA', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({ result: true });

      const subject = createSubject();
      const isEnabled = await service.isFeatureEnabled(subject, 'advanced_analytics');

      expect(isEnabled).toBe(true);
    });

    it('should use subject attributes as fallback', async () => {
      const module = await Test.createTestingModule({
        providers: [
          PolicyEnforcerService,
          {
            provide: OpaClientService,
            useValue: {
              checkHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }),
              evaluatePolicy: jest.fn(),
              on: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
            },
          },
        ],
      }).compile();

      const localService = module.get<PolicyEnforcerService>(PolicyEnforcerService);
      await localService.onModuleInit();

      const subject = createSubject({
        attributes: {
          features: {
            dark_mode: true,
            beta_features: false,
          },
        },
      });

      expect(await localService.isFeatureEnabled(subject, 'dark_mode')).toBe(true);
      expect(await localService.isFeatureEnabled(subject, 'beta_features')).toBe(false);
      expect(await localService.isFeatureEnabled(subject, 'unknown_feature')).toBe(false);
    });
  });

  describe('getEffectivePermissions', () => {
    it('should get permissions from OPA', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { permissions: ['read:farms', 'write:farms', 'read:sensors'] },
      });

      const subject = createSubject();
      const permissions = await service.getEffectivePermissions(subject);

      expect(permissions).toContain('read:farms');
      expect(permissions).toContain('write:farms');
    });

    it('should use subject permissions as fallback', async () => {
      const module = await Test.createTestingModule({
        providers: [
          PolicyEnforcerService,
          {
            provide: OpaClientService,
            useValue: {
              checkHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }),
              evaluatePolicy: jest.fn(),
              on: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
            },
          },
        ],
      }).compile();

      const localService = module.get<PolicyEnforcerService>(PolicyEnforcerService);
      await localService.onModuleInit();

      const subject = createSubject({
        permissions: ['read:farms', 'read:sensors'],
      });

      const permissions = await localService.getEffectivePermissions(subject);

      expect(permissions).toEqual(['read:farms', 'read:sensors']);
    });
  });

  describe('checkRateLimit', () => {
    it('should check rate limit with OPA', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allowed: true, limit: 1000, remaining: 500 },
      });

      const subject = createSubject();
      const rateLimit = await service.checkRateLimit(subject, '/api/v1/farms', 500);

      expect(rateLimit.allowed).toBe(true);
      expect(rateLimit.limit).toBe(1000);
      expect(rateLimit.remaining).toBe(500);
    });

    it('should use default limits as fallback', async () => {
      const module = await Test.createTestingModule({
        providers: [
          PolicyEnforcerService,
          {
            provide: OpaClientService,
            useValue: {
              checkHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }),
              evaluatePolicy: jest.fn(),
              on: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
            },
          },
        ],
      }).compile();

      const localService = module.get<PolicyEnforcerService>(PolicyEnforcerService);
      await localService.onModuleInit();

      const subject = createSubject({
        attributes: { rateLimit: 500 },
      });

      const rateLimit = await localService.checkRateLimit(subject, '/api/v1/test', 100);

      expect(rateLimit.allowed).toBe(true);
      expect(rateLimit.limit).toBe(500);
      expect(rateLimit.remaining).toBe(400);
    });
  });

  describe('canAccessSensitiveData', () => {
    it('should check sensitive data access with OPA', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({ result: true });

      const subject = createSubject();
      const canAccess = await service.canAccessSensitiveData(subject, 'confidential');

      expect(canAccess).toBe(true);
    });

    it('should use role-based fallback for restricted data', async () => {
      const module = await Test.createTestingModule({
        providers: [
          PolicyEnforcerService,
          {
            provide: OpaClientService,
            useValue: {
              checkHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }),
              evaluatePolicy: jest.fn(),
              on: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
            },
          },
        ],
      }).compile();

      const localService = module.get<PolicyEnforcerService>(PolicyEnforcerService);
      await localService.onModuleInit();

      // System admin can access restricted
      const adminSubject = createSubject({ roles: ['system_admin'] });
      expect(await localService.canAccessSensitiveData(adminSubject, 'restricted')).toBe(true);

      // Regular user cannot access restricted
      const userSubject = createSubject({ roles: ['user'] });
      expect(await localService.canAccessSensitiveData(userSubject, 'restricted')).toBe(false);

      // Everyone can access public
      expect(await localService.canAccessSensitiveData(userSubject, 'public')).toBe(true);
    });

    it('should allow tenant_admin for confidential data', async () => {
      const module = await Test.createTestingModule({
        providers: [
          PolicyEnforcerService,
          {
            provide: OpaClientService,
            useValue: {
              checkHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }),
              evaluatePolicy: jest.fn(),
              on: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
            },
          },
        ],
      }).compile();

      const localService = module.get<PolicyEnforcerService>(PolicyEnforcerService);
      await localService.onModuleInit();

      const tenantAdmin = createSubject({ roles: ['tenant_admin'] });
      expect(await localService.canAccessSensitiveData(tenantAdmin, 'confidential')).toBe(true);
      expect(await localService.canAccessSensitiveData(tenantAdmin, 'restricted')).toBe(false);
    });
  });

  describe('Fail Open/Closed Behavior', () => {
    it('should fail closed by default when evaluation fails', async () => {
      opaClient.evaluatePolicy.mockRejectedValueOnce(new Error('OPA error'));

      const decision = await service.isAuthorized(createContext());

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('Policy evaluation failed');
    });

    it('should fail open when configured', async () => {
      const module = await Test.createTestingModule({
        providers: [
          PolicyEnforcerService,
          {
            provide: OpaClientService,
            useValue: {
              checkHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
              evaluatePolicy: jest.fn().mockRejectedValue(new Error('OPA error')),
              on: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'POLICY_FAIL_OPEN') return true;
                return defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const localService = module.get<PolicyEnforcerService>(PolicyEnforcerService);
      await localService.onModuleInit();

      const decision = await localService.isAuthorized(createContext());

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('defaulting to allow');
    });
  });

  describe('Input Building', () => {
    it('should build correct OPA input structure', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({ result: { allow: true } });

      const context = createContext({
        subject: {
          id: 'user-123',
          type: 'user',
          tenantId: 'tenant-456',
          roles: ['admin'],
          permissions: ['read:all'],
          attributes: { department: 'IT' },
        },
        resource: {
          type: 'farm',
          id: 'farm-789',
          tenantId: 'tenant-456',
          ownerId: 'user-owner',
          attributes: { region: 'north' },
        },
        action: {
          name: 'update',
          method: 'PUT',
          path: '/api/v1/farms/farm-789',
        },
        environment: {
          timestamp: new Date('2024-01-01T00:00:00Z'),
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0',
          deviceFingerprint: 'fp-123',
          location: { country: 'US', region: 'CA' },
        },
      });

      await service.isAuthorized(context);

      expect(opaClient.evaluatePolicy).toHaveBeenCalledWith(
        'aquaculture/authz/resource_access',
        expect.objectContaining({
          subject: expect.objectContaining({
            id: 'user-123',
            type: 'user',
            tenant_id: 'tenant-456',
            roles: ['admin'],
            permissions: ['read:all'],
          }),
          resource: expect.objectContaining({
            type: 'farm',
            id: 'farm-789',
            tenant_id: 'tenant-456',
            owner_id: 'user-owner',
          }),
          action: expect.objectContaining({
            name: 'update',
            method: 'PUT',
            path: '/api/v1/farms/farm-789',
          }),
          environment: expect.objectContaining({
            ip_address: '192.168.1.1',
            user_agent: 'Mozilla/5.0',
          }),
        }),
      );
    });
  });

  describe('OPA Result Parsing', () => {
    it('should parse boolean result', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({ result: true });

      const subject = createSubject();
      const canAccess = await service.canAccessModule(subject, 'test');

      expect(canAccess).toBe(true);
    });

    it('should parse object with allow property', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allow: true, reason: 'granted' },
      });

      const decision = await service.isAuthorized(createContext());

      expect(decision.allowed).toBe(true);
    });

    it('should parse object with allowed property', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { allowed: false, reason: 'denied' },
      });

      const decision = await service.isAuthorized(createContext());

      expect(decision.allowed).toBe(false);
    });

    it('should default to false for unknown result format', async () => {
      opaClient.evaluatePolicy.mockResolvedValueOnce({
        result: { unknown: 'format' },
      });

      const decision = await service.isAuthorized(createContext());

      expect(decision.allowed).toBe(false);
    });
  });
});
