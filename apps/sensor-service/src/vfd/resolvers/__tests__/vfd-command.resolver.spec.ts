/**
 * VFD Command Resolver Unit Tests
 */

import { Test, TestingModule } from '@nestjs/testing';

import { VfdBrand, VfdProtocol, VfdParameterCategory, VfdCommandType } from '../../entities/vfd.enums';
import { VfdCommandService } from '../../services/vfd-command.service';
import { VfdConnectionTesterService } from '../../services/vfd-connection-tester.service';
import { VfdRegisterMappingService } from '../../services/vfd-register-mapping.service';
import { VfdCommandResolver } from '../vfd-command.resolver';

describe('VfdCommandResolver', () => {
  let resolver: VfdCommandResolver;
  let commandService: jest.Mocked<VfdCommandService>;
  let connectionTesterService: jest.Mocked<VfdConnectionTesterService>;
  let registerMappingService: jest.Mocked<VfdRegisterMappingService>;

  const tenantId = 'tenant-123';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdCommandResolver,
        {
          provide: VfdCommandService,
          useValue: {
            executeCommand: jest.fn().mockResolvedValue({ success: true, latencyMs: 25 }),
          },
        },
        {
          provide: VfdConnectionTesterService,
          useValue: {
            getSupportedProtocols: jest.fn().mockReturnValue([
              { protocol: 'modbus_tcp', name: 'Modbus TCP', connectionType: 'ethernet' },
              { protocol: 'modbus_rtu', name: 'Modbus RTU', connectionType: 'serial' },
            ]),
            getProtocolSchema: jest.fn().mockReturnValue({ type: 'object', properties: {} }),
            getDefaultConfiguration: jest.fn().mockReturnValue({ port: 502 }),
            validateConfiguration: jest.fn().mockReturnValue({ valid: true, errors: [] }),
          },
        },
        {
          provide: VfdRegisterMappingService,
          useValue: {
            getBrandsSummary: jest.fn().mockReturnValue([
              { code: 'danfoss', name: 'Danfoss', supportedProtocols: ['modbus_tcp'] },
            ]),
            getMappingsForBrand: jest.fn().mockResolvedValue([
              { parameterName: 'output_frequency', registerAddress: 16129 },
            ]),
            getMappingsByCategory: jest.fn().mockResolvedValue([
              { parameterName: 'motor_current', registerAddress: 16139 },
            ]),
          },
        },
      ],
    }).compile();

    resolver = module.get<VfdCommandResolver>(VfdCommandResolver);
    commandService = module.get(VfdCommandService);
    connectionTesterService = module.get(VfdConnectionTesterService);
    registerMappingService = module.get(VfdRegisterMappingService);
  });

  // DB-SENSOR-HIGH-003: mutations now capture the acting user for the command
  // audit trail; the resolver maps @CurrentUser → { userId, email }.
  const mockUser = { sub: 'user-1', email: 'u@test.com', tenantId, roles: [] } as never;
  const expectedActor = { userId: 'user-1', email: 'u@test.com' };

  describe('Command Mutations', () => {
    describe('sendCommand', () => {
      it('should send a command to VFD device', async () => {
        const result = await resolver.sendCommand(
          'device-123',
          { command: VfdCommandType.START },
          tenantId,
          mockUser
        );

        expect(result.success).toBe(true);
        expect(commandService.executeCommand).toHaveBeenCalledWith(
          'device-123',
          tenantId,
          { command: VfdCommandType.START },
          expectedActor
        );
      });
    });

    describe('startVfd', () => {
      it('should send START command', async () => {
        const result = await resolver.startVfd('device-123', tenantId, mockUser);

        expect(result.success).toBe(true);
        expect(commandService.executeCommand).toHaveBeenCalledWith(
          'device-123',
          tenantId,
          { command: VfdCommandType.START },
          expectedActor
        );
      });
    });

    describe('stopVfd', () => {
      it('should send STOP command', async () => {
        const result = await resolver.stopVfd('device-123', tenantId, mockUser);

        expect(result.success).toBe(true);
        expect(commandService.executeCommand).toHaveBeenCalledWith(
          'device-123',
          tenantId,
          { command: VfdCommandType.STOP },
          expectedActor
        );
      });
    });

    describe('setFrequency', () => {
      it('should send SET_FREQUENCY command with value', async () => {
        const result = await resolver.setFrequency('device-123', 45.0, tenantId, mockUser);

        expect(result.success).toBe(true);
        expect(commandService.executeCommand).toHaveBeenCalledWith(
          'device-123',
          tenantId,
          { command: VfdCommandType.SET_FREQUENCY, value: 45.0 },
          expectedActor
        );
      });
    });

    describe('setSpeed', () => {
      it('should send SET_SPEED command with percentage', async () => {
        const result = await resolver.setSpeed('device-123', 75.0, tenantId, mockUser);

        expect(result.success).toBe(true);
        expect(commandService.executeCommand).toHaveBeenCalledWith(
          'device-123',
          tenantId,
          { command: VfdCommandType.SET_SPEED, value: 75.0 },
          expectedActor
        );
      });
    });

    describe('resetFault', () => {
      it('should send FAULT_RESET command', async () => {
        const result = await resolver.resetFault('device-123', tenantId, mockUser);

        expect(result.success).toBe(true);
        expect(commandService.executeCommand).toHaveBeenCalledWith(
          'device-123',
          tenantId,
          { command: VfdCommandType.FAULT_RESET },
          expectedActor
        );
      });
    });

    describe('emergencyStop', () => {
      it('should send EMERGENCY_STOP command', async () => {
        const result = await resolver.emergencyStop('device-123', tenantId, mockUser);

        expect(result.success).toBe(true);
        expect(commandService.executeCommand).toHaveBeenCalledWith(
          'device-123',
          tenantId,
          { command: VfdCommandType.EMERGENCY_STOP },
          expectedActor
        );
      });
    });
  });

  describe('Configuration Queries', () => {
    describe('getVfdBrands', () => {
      it('should return VFD brand information', async () => {
        const result = await resolver.getVfdBrands();

        expect(result).toHaveLength(1);
        // The resolver's GraphQL Object type produces an `unknown[]`
        // shape under TS-compiled jest specs because `getBrandsSummary`
        // is mocked with a free-form return shape. Cast at the
        // assertion boundary so the test reads cleanly without the
        // `result[0]` being inferred as `unknown`.
        expect(((result as unknown[])[0] as { code: string }).code).toBe('danfoss');
        expect(registerMappingService.getBrandsSummary).toHaveBeenCalled();
      });
    });

    describe('getVfdProtocols', () => {
      it('should return supported protocols', async () => {
        const result = await resolver.getVfdProtocols();

        expect(result).toHaveLength(2);
        expect(connectionTesterService.getSupportedProtocols).toHaveBeenCalled();
      });
    });

    describe('getProtocolSchema', () => {
      it('should return protocol configuration schema', async () => {
        const result = await resolver.getProtocolSchema(VfdProtocol.MODBUS_TCP);

        expect(result).toBeDefined();
        expect(connectionTesterService.getProtocolSchema).toHaveBeenCalledWith(
          VfdProtocol.MODBUS_TCP
        );
      });
    });

    describe('getProtocolDefaultConfig', () => {
      it('should return default protocol configuration', async () => {
        const result = await resolver.getProtocolDefaultConfig(VfdProtocol.MODBUS_TCP);

        expect(result).toBeDefined();
        expect((result as { port: number }).port).toBe(502);
      });
    });

    describe('getRegisterMappings', () => {
      it('should return register mappings for brand and model', async () => {
        const result = await resolver.getRegisterMappings(VfdBrand.DANFOSS, 'FC302');

        expect(result).toHaveLength(1);
        expect(registerMappingService.getMappingsForBrand).toHaveBeenCalledWith(
          VfdBrand.DANFOSS,
          'FC302'
        );
      });
    });

    describe('getRegisterMappingsByCategory', () => {
      it('should return register mappings by category', async () => {
        const result = await resolver.getRegisterMappingsByCategory(
          VfdBrand.DANFOSS,
          VfdParameterCategory.MOTOR
        );

        expect(result).toHaveLength(1);
        expect(registerMappingService.getMappingsByCategory).toHaveBeenCalledWith(
          VfdBrand.DANFOSS,
          VfdParameterCategory.MOTOR
        );
      });
    });

    describe('getBrandCommands', () => {
      it('should return control commands for a brand', async () => {
        const result = await resolver.getBrandCommands(VfdBrand.DANFOSS);

        expect(result).toBeDefined();
        expect(typeof result).toBe('object');
      });
    });

    describe('validateConfig', () => {
      it('should validate protocol configuration', async () => {
        const result = await resolver.validateConfig(
          VfdProtocol.MODBUS_TCP,
          { host: '192.168.1.100', port: 502 }
        );

        expect(result.valid).toBe(true);
        expect(connectionTesterService.validateConfiguration).toHaveBeenCalled();
      });
    });
  });
});
