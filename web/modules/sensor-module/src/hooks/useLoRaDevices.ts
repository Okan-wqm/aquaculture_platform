/**
 * LoRa device hooks for LoRaWAN end-device management
 * TanStack React Query ile CRUD + downlink islemleri
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../config/api';
import {
  LORA_DEVICES_QUERY,
  ADD_LORA_DEVICE_MUTATION,
  REMOVE_LORA_DEVICE,
  SEND_LORA_DOWNLINK,
} from '../graphql/lora-device.queries';

// ==================== Types ====================

export interface LoRaDevice {
  id: string;
  devEui: string;
  appEui: string;
  name: string;
  tagPrefix: string;
  activationMode: 'OTAA' | 'ABP';
  deviceClass: 'A' | 'B' | 'C';
  codec: string;
  adrEnabled: boolean;
  fPort: number;
  devAddr?: string;
  isJoined: boolean;
  joinedAt?: string;
  lastSeenAt?: string;
  lastRssi?: number;
  lastSnr?: number;
  frameCountUp?: number;
  createdAt: string;
}

export interface AddLoRaDeviceInput {
  devEui: string;
  appKey: string;
  name: string;
  tagPrefix: string;
  activationMode: 'OTAA' | 'ABP';
  deviceClass: 'A' | 'C';
  codec: string;
}

export interface LoRaDownlinkInput {
  payload: string;
  fPort?: number;
  confirmed?: boolean;
}

export interface LoRaDownlinkResult {
  success: boolean;
  error?: string;
}

// ==================== Query Hooks ====================

/**
 * Hook to fetch LoRa devices for a given edge device.
 * 5 saniye refetch interval ile canli durum takibi.
 */
export function useLoRaDevices(edgeDeviceId: string) {
  const { token } = useAuth();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'loraDevices', edgeDeviceId),
    queryFn: async () => {
      const data = await graphqlFetch<{ loraDevices: LoRaDevice[] }>(
        LORA_DEVICES_QUERY,
        { edgeDeviceId },
      );
      return data.loraDevices;
    },
    staleTime: 5000,
    refetchInterval: 5000,
    refetchIntervalInBackground: false, // Arka planda gereksiz polling yapma
    enabled: !!token && !!edgeDeviceId,
  });
}

// ==================== Mutation Hooks ====================

/**
 * Hook to add a new LoRa device to an edge controller.
 * Cache invalidation: loraDevices listesini yeniler.
 */
export function useAddLoRaDevice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async ({
      edgeDeviceId,
      input,
    }: {
      edgeDeviceId: string;
      input: AddLoRaDeviceInput;
    }) => {
      const data = await graphqlFetch<{ addLoRaDevice: LoRaDevice }>(
        ADD_LORA_DEVICE_MUTATION,
        { edgeDeviceId, input },
      );
      return data.addLoRaDevice;
    },
    onSuccess: (_, { edgeDeviceId }) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'loraDevices', edgeDeviceId) });
    },
  });
}

/**
 * Hook to remove a LoRa device from an edge controller.
 */
export function useRemoveLoRaDevice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async ({
      edgeDeviceId,
      loraDeviceId,
    }: {
      edgeDeviceId: string;
      loraDeviceId: string;
    }) => {
      const data = await graphqlFetch<{ removeLoRaDevice: boolean }>(
        REMOVE_LORA_DEVICE,
        { edgeDeviceId, loraDeviceId },
      );
      return data.removeLoRaDevice;
    },
    onSuccess: (_, { edgeDeviceId }) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'loraDevices', edgeDeviceId) });
    },
  });
}

/**
 * Hook to send a downlink message to a LoRa device.
 * Hex payload + fPort parametreleri ile MQTT uzerinden iletilir.
 */
export function useSendLoRaDownlink() {
  const { token } = useAuth();
  return useMutation({
    mutationFn: async ({
      edgeDeviceId,
      loraDeviceId,
      input,
    }: {
      edgeDeviceId: string;
      loraDeviceId: string;
      input: LoRaDownlinkInput;
    }) => {
      const data = await graphqlFetch<{ sendLoRaDownlink: LoRaDownlinkResult }>(
        SEND_LORA_DOWNLINK,
        { edgeDeviceId, loraDeviceId, input },
      );
      return data.sendLoRaDownlink;
    },
  });
}
