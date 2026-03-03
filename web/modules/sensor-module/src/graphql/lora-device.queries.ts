/**
 * GraphQL queries and mutations for LoRa device management
 * LoRaWAN end-device lifecycle: join, uplink/downlink, remove
 */

// ==================== Queries ====================

export const LORA_DEVICES_QUERY = `
  query LoRaDevices($edgeDeviceId: ID!) {
    loraDevices(edgeDeviceId: $edgeDeviceId) {
      id
      devEui
      appEui
      name
      tagPrefix
      activationMode
      deviceClass
      codec
      adrEnabled
      fPort
      isJoined
      joinedAt
      lastSeenAt
      lastRssi
      lastSnr
      frameCountUp
      createdAt
    }
  }
`;

// ==================== Mutations ====================

export const ADD_LORA_DEVICE_MUTATION = `
  mutation AddLoRaDevice($edgeDeviceId: ID!, $input: AddLoRaDeviceInput!) {
    addLoRaDevice(edgeDeviceId: $edgeDeviceId, input: $input) {
      id
      devEui
      appEui
      name
      tagPrefix
      activationMode
      deviceClass
      codec
      adrEnabled
      fPort
      isJoined
      createdAt
    }
  }
`;

export const REMOVE_LORA_DEVICE = `
  mutation RemoveLoRaDevice($edgeDeviceId: ID!, $loraDeviceId: ID!) {
    removeLoRaDevice(edgeDeviceId: $edgeDeviceId, loraDeviceId: $loraDeviceId)
  }
`;

export const SEND_LORA_DOWNLINK = `
  mutation SendLoRaDownlink($edgeDeviceId: ID!, $loraDeviceId: ID!, $input: SendLoRaDownlinkInput!) {
    sendLoRaDownlink(edgeDeviceId: $edgeDeviceId, loraDeviceId: $loraDeviceId, input: $input) {
      success
      error
    }
  }
`;
