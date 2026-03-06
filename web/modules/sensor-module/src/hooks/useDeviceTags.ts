import { useMemo } from 'react';
import { useEdgeDevice, IoType, DeviceIoConfig } from './useEdgeDevices';

export interface TagInfo {
  name: string;
  ioType: IoType;
  direction: 'input' | 'output';
  unit: string;
  channel: number;
  description?: string;
}

export interface TagGroup {
  label: string;
  ioType: IoType;
  tags: TagInfo[];
}

export function useDeviceTags(deviceId: string | null) {
  const { data: device, isLoading, isError, error } = useEdgeDevice(deviceId || '');

  const tags = useMemo<TagInfo[]>(() => {
    if (!device?.ioConfig) return [];
    return device.ioConfig
      .filter((io: DeviceIoConfig) => io.isActive)
      .map((io: DeviceIoConfig) => ({
        name: io.tagName,
        ioType: io.ioType,
        direction: (io.ioType === IoType.DI || io.ioType === IoType.AI) ? 'input' as const : 'output' as const,
        unit: io.engUnit || '',
        channel: io.channel,
        description: io.description,
      }));
  }, [device]);

  const groupedTags = useMemo<TagGroup[]>(() => {
    const groups: Record<string, TagGroup> = {};
    const groupLabels: Record<string, string> = {
      [IoType.AI]: 'Analog Input',
      [IoType.AO]: 'Analog Output',
      [IoType.DI]: 'Digital Input',
      [IoType.DO]: 'Digital Output',
    };

    for (const tag of tags) {
      if (!groups[tag.ioType]) {
        groups[tag.ioType] = {
          label: groupLabels[tag.ioType] || tag.ioType,
          ioType: tag.ioType,
          tags: [],
        };
      }
      groups[tag.ioType].tags.push(tag);
    }

    // Order: AI, AO, DI, DO
    return [IoType.AI, IoType.AO, IoType.DI, IoType.DO]
      .filter((t) => groups[t])
      .map((t) => groups[t]);
  }, [tags]);

  return {
    tags,
    groupedTags,
    loading: !!deviceId && isLoading,
    error: isError ? (error as Error)?.message || 'Failed to load tags' : null,
  };
}
