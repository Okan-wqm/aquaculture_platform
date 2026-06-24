import { Injectable } from '@nestjs/common';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

/**
 * LoRaWAN Protocol Configuration
 *
 * LoRaWAN, düşük güç tüketimi ve uzun menzil sunan LPWAN protokolüdür.
 * Akvakültür ortamında uzak havuz/gölet'lerdeki sensörlere kablolama
 * gerektirmeden bağlantı sağlar (tipik menzil: 2-15 km açık alan).
 *
 * Bu adapter, edge device'ın SX1302 concentrator HAT'ı üzerinden
 * LoRa end-device'larla iletişimi yönetir. Gerçek RF iletişimi
 * Rust edge agent tarafında gerçekleşir; bu adapter cloud-side
 * yapılandırma ve doğrulama katmanıdır.
 */
interface LorawanConfig {
  sensorId?: string;
  tenantId?: string;
  devEui?: string;
  activationMode?: 'OTAA' | 'ABP';
  appKey?: string;
  appEui?: string;
  devAddr?: string;
  nwkSKey?: string;
  appSKey?: string;
  edgeDeviceId?: string;
}

@Injectable()
export class LorawanAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'LORAWAN';
  readonly category = ProtocolCategory.WIRELESS;
  readonly subcategory = ProtocolSubcategory.LPWAN;
  readonly connectionType = ConnectionType.WIRELESS;
  readonly displayName = 'LoRaWAN';
  readonly description = 'LoRaWAN Low Power Wide Area Network protocol via SX1302 concentrator';

  /**
   * Connect to a LoRa end-device.
   *
   * LoRaWAN bağlantısı geleneksel TCP/IP bağlantısından farklıdır:
   * Gerçek RF bağlantısı edge agent tarafında SX1302 üzerinden yönetilir.
   * Bu metod, cloud-side connection handle oluşturur ve edge device'ın
   * LoRa capability'sine sahip olduğunu doğrular.
   */
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const cfg = config as LorawanConfig;

    if (!cfg.devEui) {
      throw new Error('DevEUI is required for LoRaWAN connection');
    }

    this.logger.log(`Creating LoRaWAN connection handle for DevEUI: ${cfg.devEui}`);

    return this.createConnectionHandle(
      cfg.sensorId ?? cfg.devEui ?? 'unknown',
      cfg.tenantId ?? 'unknown',
      config,
    );
  }

   
  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.logger.log(`Disconnecting LoRaWAN handle: ${handle.id}`);
    this.removeConnectionHandle(handle.id);
  }

  /**
   * Test LoRaWAN connection availability.
   *
   * LoRaWAN'da gerçek zamanlı bağlantı testi mümkün değildir çünkü
   * Class A cihazlar sadece uplink sonrası kısa RX window'larında
   * dinleme yapar. Bu metod yapılandırma geçerliliğini kontrol eder.
   */
   
  async testConnection(_config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const cfg = _config as LorawanConfig;
    const validation = this.validateConfiguration(cfg);

    if (!validation.isValid) {
      return {
        success: false,
        latencyMs: 0,
        error: validation.errors.map(e => e.message).join(', '),
      };
    }

    // LoRaWAN bağlantı testi: yapılandırma geçerli, ancak gerçek RF testi
    // sadece edge agent üzerinden yapılabilir (join request gönderilerek).
    return { success: true, latencyMs: 0 };
  }

  /**
   * Read data from LoRa end-device.
   *
   * LoRaWAN push-based bir protokoldür — cihaz kendi zamanlayıcısına
   * göre uplink gönderir. Polling desteklenmez. Veriler MQTT
   * lora_events topic'i üzerinden gelir ve mqtt-listener tarafından işlenir.
   *
   * Bu metod, en son alınan veriyi döndürmek yerine bilgilendirici
   * bir yanıt döner.
   */
   
  async readData(_handle: ConnectionHandle): Promise<SensorReadingData> {
    // LoRaWAN push-based: veri MQTT topic'inden gelir, polling desteklenmez
    return {
      timestamp: new Date(),
      values: {},
      quality: 0,
      source: 'lorawan',
    };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as LorawanConfig;
    const errors = [];

    if (!cfg.devEui) {
      errors.push(this.validationError('devEui', 'Device EUI is required'));
    } else if (!/^[0-9A-Fa-f]{16}$/.test(cfg.devEui)) {
      errors.push(this.validationError('devEui', 'Device EUI must be exactly 16 hex characters'));
    }

    if (cfg.activationMode === 'OTAA') {
      if (!cfg.appKey) errors.push(this.validationError('appKey', 'App Key is required for OTAA'));
      else if (!/^[0-9A-Fa-f]{32}$/.test(cfg.appKey)) {
        errors.push(this.validationError('appKey', 'App Key must be exactly 32 hex characters'));
      }
      if (!cfg.appEui) errors.push(this.validationError('appEui', 'App EUI is required for OTAA'));
      else if (!/^[0-9A-Fa-f]{16}$/.test(cfg.appEui)) {
        errors.push(this.validationError('appEui', 'App EUI must be exactly 16 hex characters'));
      }
    } else if (cfg.activationMode === 'ABP') {
      if (!cfg.devAddr) errors.push(this.validationError('devAddr', 'Device Address is required for ABP'));
      else if (!/^[0-9A-Fa-f]{8}$/.test(cfg.devAddr)) {
        errors.push(this.validationError('devAddr', 'Device Address must be exactly 8 hex characters'));
      }
      if (!cfg.nwkSKey) errors.push(this.validationError('nwkSKey', 'Network Session Key is required for ABP'));
      if (!cfg.appSKey) errors.push(this.validationError('appSKey', 'App Session Key is required for ABP'));
    }

    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'LoRaWAN Configuration', required: ['devEui', 'activationMode'],
      properties: {
        networkServer: { type: 'string', title: 'Network Server URL', 'ui:order': 1, 'ui:group': 'network' },
        networkServerType: { type: 'string', title: 'Network Server Type', enum: ['The Things Network', 'ChirpStack', 'Loriot', 'AWS IoT Core', 'Custom'], default: 'The Things Network', 'ui:order': 2, 'ui:group': 'network' },
        region: { type: 'string', title: 'Region', enum: ['EU868', 'US915', 'AU915', 'AS923', 'KR920', 'IN865', 'RU864'], default: 'EU868', 'ui:order': 3, 'ui:group': 'network' },
        devEui: { type: 'string', title: 'Device EUI', description: '16 hex characters', 'ui:placeholder': '0011223344556677', 'ui:order': 4, 'ui:group': 'device' },
        activationMode: { type: 'string', title: 'Activation Mode', enum: ['OTAA', 'ABP'], default: 'OTAA', 'ui:order': 5, 'ui:group': 'device' },
        deviceClass: { type: 'string', title: 'Device Class', enum: ['A', 'B', 'C'], default: 'A', 'ui:order': 6, 'ui:group': 'device' },
        appEui: { type: 'string', title: 'App EUI (OTAA)', description: '16 hex characters', 'ui:order': 7, 'ui:group': 'otaa' },
        appKey: { type: 'string', title: 'App Key (OTAA)', description: '32 hex characters', 'ui:order': 8, 'ui:group': 'otaa', 'ui:widget': 'password' },
        devAddr: { type: 'string', title: 'Device Address (ABP)', description: '8 hex characters', 'ui:order': 9, 'ui:group': 'abp' },
        nwkSKey: { type: 'string', title: 'Network Session Key (ABP)', description: '32 hex characters', 'ui:order': 10, 'ui:group': 'abp', 'ui:widget': 'password' },
        appSKey: { type: 'string', title: 'App Session Key (ABP)', description: '32 hex characters', 'ui:order': 11, 'ui:group': 'abp', 'ui:widget': 'password' },
        fPort: { type: 'integer', title: 'FPort', default: 1, minimum: 1, maximum: 223, 'ui:order': 12, 'ui:group': 'advanced' },
        adr: { type: 'boolean', title: 'ADR (Adaptive Data Rate)', default: true, 'ui:order': 13, 'ui:group': 'advanced' },
        confirmed: { type: 'boolean', title: 'Confirmed Uplinks', default: false, 'ui:order': 14, 'ui:group': 'advanced' },
      },
      'ui:groups': [
        { name: 'network', title: 'Network Server', fields: ['networkServer', 'networkServerType', 'region'] },
        { name: 'device', title: 'Device', fields: ['devEui', 'activationMode', 'deviceClass'] },
        { name: 'otaa', title: 'OTAA Keys', fields: ['appEui', 'appKey'] },
        { name: 'abp', title: 'ABP Keys', fields: ['devAddr', 'nwkSKey', 'appSKey'] },
        { name: 'advanced', title: 'Advanced', fields: ['fPort', 'adr', 'confirmed'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { networkServer: '', networkServerType: 'The Things Network', region: 'EU868', devEui: '', activationMode: 'OTAA', deviceClass: 'A', appEui: '', appKey: '', fPort: 1, adr: true, confirmed: false };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: false, supportsSubscription: true, supportsAuthentication: true, supportsEncryption: true, supportedDataTypes: ['BINARY', 'CAYENNE_LPP', 'JSON'] };
  }
}
