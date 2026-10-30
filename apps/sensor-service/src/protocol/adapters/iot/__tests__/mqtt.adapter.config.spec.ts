import { MqttAdapter } from '../mqtt.adapter';

/**
 * ADR-047 §1, §8: an MQTT sensor publishes to the platform broker with the
 * principal it is issued after registration, so its configuration names no
 * broker, port, topic, client ID or credential, and its payload is JSON. The
 * wizard renders this schema, so it asks for none of them.
 */
describe('MqttAdapter configuration (platform broker)', () => {
  const adapter = new MqttAdapter();

  it('asks for nothing: the connection is issued after registration', () => {
    expect(adapter.getConfigurationSchema().properties).toEqual({});
    expect(adapter.getConfigurationSchema().required).toBeUndefined();
    expect(adapter.getDefaultConfiguration()).toEqual({});
  });

  it.each([[{}], [{ payloadFormat: 'json' }], [{ topic: '', username: null }]])(
    'accepts %j',
    (config) => {
      expect(adapter.validateConfiguration(config)).toMatchObject({ isValid: true, errors: [] });
    },
  );

  it.each([
    ['brokerUrl', { brokerUrl: 'mosquitto' }],
    ['topic', { topic: 'sensors/farm-01/water-quality' }],
    ['username', { username: 'sensor_service' }],
    ['password', { password: 'typed-in-the-wizard' }],
    ['clientId', { clientId: 'nodered-simulator' }],
    ['payloadFormat', { payloadFormat: 'csv' }],
  ])('refuses %s', (field, config) => {
    const result = adapter.validateConfiguration(config);
    expect(result.isValid).toBe(false);
    expect(result.errors.map((error) => error.field)).toEqual([field]);
  });
});
