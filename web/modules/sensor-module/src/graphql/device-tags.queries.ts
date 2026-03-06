export const EDGE_DEVICE_IO_TAGS_QUERY = `
  query EdgeDeviceIoTags($id: ID!) {
    edgeDevice(id: $id) {
      id
      deviceName
      ioConfig {
        id
        tagName
        description
        ioType
        dataType
        channel
        engUnit
        isActive
      }
    }
  }
`;
