import { useState, useCallback } from 'react';
import {
  VfdCommandType,
  VfdCommandResult,
  VfdCommand,
  VFD_COMMAND_NAMES,
} from '../types/vfd.types';

// API base URL
const API_URL = 'http://localhost:3000/graphql';

// GraphQL fetch helper
async function graphqlFetch<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = localStorage.getItem('access_token');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// GraphQL Mutations
const SEND_VFD_COMMAND_MUTATION = `
  mutation SendVfdCommand($vfdDeviceId: ID!, $command: VfdCommandInput!) {
    sendVfdCommand(vfdDeviceId: $vfdDeviceId, command: $command) {
      success
      command
      acknowledgedAt
      executionTimeMs
      error
      previousValue
      newValue
    }
  }
`;

const START_VFD_MUTATION = `
  mutation StartVfd($vfdDeviceId: ID!) {
    startVfd(vfdDeviceId: $vfdDeviceId) {
      success
      command
      acknowledgedAt
      error
    }
  }
`;

const STOP_VFD_MUTATION = `
  mutation StopVfd($vfdDeviceId: ID!) {
    stopVfd(vfdDeviceId: $vfdDeviceId) {
      success
      command
      acknowledgedAt
      error
    }
  }
`;

const SET_VFD_FREQUENCY_MUTATION = `
  mutation SetVfdFrequency($vfdDeviceId: ID!, $frequencyHz: Float!) {
    setVfdFrequency(vfdDeviceId: $vfdDeviceId, frequencyHz: $frequencyHz) {
      success
      command
      acknowledgedAt
      error
      previousValue
      newValue
    }
  }
`;

const SET_VFD_SPEED_MUTATION = `
  mutation SetVfdSpeed($vfdDeviceId: ID!, $speedPercent: Float!) {
    setVfdSpeed(vfdDeviceId: $vfdDeviceId, speedPercent: $speedPercent) {
      success
      command
      acknowledgedAt
      error
      previousValue
      newValue
    }
  }
`;

const RESET_VFD_FAULT_MUTATION = `
  mutation ResetVfdFault($vfdDeviceId: ID!) {
    resetVfdFault(vfdDeviceId: $vfdDeviceId) {
      success
      command
      acknowledgedAt
      error
    }
  }
`;

const EMERGENCY_STOP_VFD_MUTATION = `
  mutation EmergencyStopVfd($vfdDeviceId: ID!) {
    emergencyStopVfd(vfdDeviceId: $vfdDeviceId) {
      success
      command
      acknowledgedAt
      error
    }
  }
`;

/**
 * Command history entry
 */
interface CommandHistoryEntry {
  id: string;
  command: VfdCommandType;
  value?: number;
  result: VfdCommandResult;
  timestamp: Date;
}

/**
 * Hook for VFD command execution
 */
export function useVfdCommands(vfdDeviceId: string | undefined) {
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] = useState<VfdCommandResult | null>(null);
  const [commandHistory, setCommandHistory] = useState<CommandHistoryEntry[]>([]);

  // Add command to history
  const addToHistory = useCallback((command: VfdCommandType, value: number | undefined, result: VfdCommandResult) => {
    const entry: CommandHistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      command,
      value,
      result,
      timestamp: new Date(),
    };

    setCommandHistory((prev) => [entry, ...prev].slice(0, 50)); // Keep last 50 commands
  }, []);

  // Generic command sender
  const sendCommand = useCallback(
    async (command: VfdCommand): Promise<VfdCommandResult> => {
      if (!vfdDeviceId) {
        const errorResult: VfdCommandResult = {
          success: false,
          command: command.command,
          error: 'VFD device ID is required',
        };
        setLastResult(errorResult);
        return errorResult;
      }

      setLoading(true);

      try {
        const data = await graphqlFetch<{ sendVfdCommand: VfdCommandResult }>(
          SEND_VFD_COMMAND_MUTATION,
          {
            vfdDeviceId,
            command: {
              command: command.command,
              value: command.value,
            },
          }
        );

        const result = data.sendVfdCommand;
        setLastResult(result);
        addToHistory(command.command, command.value, result);
        return result;
      } catch (err) {
        const errorResult: VfdCommandResult = {
          success: false,
          command: command.command,
          error: (err as Error).message,
        };
        setLastResult(errorResult);
        addToHistory(command.command, command.value, errorResult);
        return errorResult;
      } finally {
        setLoading(false);
      }
    },
    [vfdDeviceId, addToHistory]
  );

  // Start VFD
  const start = useCallback(async (): Promise<VfdCommandResult> => {
    if (!vfdDeviceId) {
      const errorResult: VfdCommandResult = {
        success: false,
        command: VfdCommandType.START,
        error: 'VFD device ID is required',
      };
      setLastResult(errorResult);
      return errorResult;
    }

    setLoading(true);

    try {
      const data = await graphqlFetch<{ startVfd: VfdCommandResult }>(
        START_VFD_MUTATION,
        { vfdDeviceId }
      );

      const result = data.startVfd;
      setLastResult(result);
      addToHistory(VfdCommandType.START, undefined, result);
      return result;
    } catch (err) {
      const errorResult: VfdCommandResult = {
        success: false,
        command: VfdCommandType.START,
        error: (err as Error).message,
      };
      setLastResult(errorResult);
      addToHistory(VfdCommandType.START, undefined, errorResult);
      return errorResult;
    } finally {
      setLoading(false);
    }
  }, [vfdDeviceId, addToHistory]);

  // Stop VFD
  const stop = useCallback(async (): Promise<VfdCommandResult> => {
    if (!vfdDeviceId) {
      const errorResult: VfdCommandResult = {
        success: false,
        command: VfdCommandType.STOP,
        error: 'VFD device ID is required',
      };
      setLastResult(errorResult);
      return errorResult;
    }

    setLoading(true);

    try {
      const data = await graphqlFetch<{ stopVfd: VfdCommandResult }>(
        STOP_VFD_MUTATION,
        { vfdDeviceId }
      );

      const result = data.stopVfd;
      setLastResult(result);
      addToHistory(VfdCommandType.STOP, undefined, result);
      return result;
    } catch (err) {
      const errorResult: VfdCommandResult = {
        success: false,
        command: VfdCommandType.STOP,
        error: (err as Error).message,
      };
      setLastResult(errorResult);
      addToHistory(VfdCommandType.STOP, undefined, errorResult);
      return errorResult;
    } finally {
      setLoading(false);
    }
  }, [vfdDeviceId, addToHistory]);

  // Set frequency
  const setFrequency = useCallback(
    async (frequencyHz: number): Promise<VfdCommandResult> => {
      if (!vfdDeviceId) {
        const errorResult: VfdCommandResult = {
          success: false,
          command: VfdCommandType.SET_FREQUENCY,
          error: 'VFD device ID is required',
        };
        setLastResult(errorResult);
        return errorResult;
      }

      // Validate frequency range
      if (frequencyHz < 0 || frequencyHz > 400) {
        const errorResult: VfdCommandResult = {
          success: false,
          command: VfdCommandType.SET_FREQUENCY,
          error: 'Frequency must be between 0 and 400 Hz',
        };
        setLastResult(errorResult);
        return errorResult;
      }

      setLoading(true);

      try {
        const data = await graphqlFetch<{ setVfdFrequency: VfdCommandResult }>(
          SET_VFD_FREQUENCY_MUTATION,
          { vfdDeviceId, frequencyHz }
        );

        const result = data.setVfdFrequency;
        setLastResult(result);
        addToHistory(VfdCommandType.SET_FREQUENCY, frequencyHz, result);
        return result;
      } catch (err) {
        const errorResult: VfdCommandResult = {
          success: false,
          command: VfdCommandType.SET_FREQUENCY,
          error: (err as Error).message,
        };
        setLastResult(errorResult);
        addToHistory(VfdCommandType.SET_FREQUENCY, frequencyHz, errorResult);
        return errorResult;
      } finally {
        setLoading(false);
      }
    },
    [vfdDeviceId, addToHistory]
  );

  // Set speed percentage
  const setSpeed = useCallback(
    async (speedPercent: number): Promise<VfdCommandResult> => {
      if (!vfdDeviceId) {
        const errorResult: VfdCommandResult = {
          success: false,
          command: VfdCommandType.SET_SPEED,
          error: 'VFD device ID is required',
        };
        setLastResult(errorResult);
        return errorResult;
      }

      // Validate speed range
      if (speedPercent < 0 || speedPercent > 100) {
        const errorResult: VfdCommandResult = {
          success: false,
          command: VfdCommandType.SET_SPEED,
          error: 'Speed must be between 0 and 100%',
        };
        setLastResult(errorResult);
        return errorResult;
      }

      setLoading(true);

      try {
        const data = await graphqlFetch<{ setVfdSpeed: VfdCommandResult }>(
          SET_VFD_SPEED_MUTATION,
          { vfdDeviceId, speedPercent }
        );

        const result = data.setVfdSpeed;
        setLastResult(result);
        addToHistory(VfdCommandType.SET_SPEED, speedPercent, result);
        return result;
      } catch (err) {
        const errorResult: VfdCommandResult = {
          success: false,
          command: VfdCommandType.SET_SPEED,
          error: (err as Error).message,
        };
        setLastResult(errorResult);
        addToHistory(VfdCommandType.SET_SPEED, speedPercent, errorResult);
        return errorResult;
      } finally {
        setLoading(false);
      }
    },
    [vfdDeviceId, addToHistory]
  );

  // Reset fault
  const resetFault = useCallback(async (): Promise<VfdCommandResult> => {
    if (!vfdDeviceId) {
      const errorResult: VfdCommandResult = {
        success: false,
        command: VfdCommandType.FAULT_RESET,
        error: 'VFD device ID is required',
      };
      setLastResult(errorResult);
      return errorResult;
    }

    setLoading(true);

    try {
      const data = await graphqlFetch<{ resetVfdFault: VfdCommandResult }>(
        RESET_VFD_FAULT_MUTATION,
        { vfdDeviceId }
      );

      const result = data.resetVfdFault;
      setLastResult(result);
      addToHistory(VfdCommandType.FAULT_RESET, undefined, result);
      return result;
    } catch (err) {
      const errorResult: VfdCommandResult = {
        success: false,
        command: VfdCommandType.FAULT_RESET,
        error: (err as Error).message,
      };
      setLastResult(errorResult);
      addToHistory(VfdCommandType.FAULT_RESET, undefined, errorResult);
      return errorResult;
    } finally {
      setLoading(false);
    }
  }, [vfdDeviceId, addToHistory]);

  // Emergency stop
  const emergencyStop = useCallback(async (): Promise<VfdCommandResult> => {
    if (!vfdDeviceId) {
      const errorResult: VfdCommandResult = {
        success: false,
        command: VfdCommandType.EMERGENCY_STOP,
        error: 'VFD device ID is required',
      };
      setLastResult(errorResult);
      return errorResult;
    }

    setLoading(true);

    try {
      const data = await graphqlFetch<{ emergencyStopVfd: VfdCommandResult }>(
        EMERGENCY_STOP_VFD_MUTATION,
        { vfdDeviceId }
      );

      const result = data.emergencyStopVfd;
      setLastResult(result);
      addToHistory(VfdCommandType.EMERGENCY_STOP, undefined, result);
      return result;
    } catch (err) {
      const errorResult: VfdCommandResult = {
        success: false,
        command: VfdCommandType.EMERGENCY_STOP,
        error: (err as Error).message,
      };
      setLastResult(errorResult);
      addToHistory(VfdCommandType.EMERGENCY_STOP, undefined, errorResult);
      return errorResult;
    } finally {
      setLoading(false);
    }
  }, [vfdDeviceId, addToHistory]);

  // Reverse direction
  const reverse = useCallback(async (): Promise<VfdCommandResult> => {
    return sendCommand({ command: VfdCommandType.REVERSE });
  }, [sendCommand]);

  // Jog forward
  const jogForward = useCallback(async (): Promise<VfdCommandResult> => {
    return sendCommand({ command: VfdCommandType.JOG_FORWARD });
  }, [sendCommand]);

  // Jog reverse
  const jogReverse = useCallback(async (): Promise<VfdCommandResult> => {
    return sendCommand({ command: VfdCommandType.JOG_REVERSE });
  }, [sendCommand]);

  // Coast stop
  const coastStop = useCallback(async (): Promise<VfdCommandResult> => {
    return sendCommand({ command: VfdCommandType.COAST_STOP });
  }, [sendCommand]);

  // Quick stop
  const quickStop = useCallback(async (): Promise<VfdCommandResult> => {
    return sendCommand({ command: VfdCommandType.QUICK_STOP });
  }, [sendCommand]);

  // Clear command history
  const clearHistory = useCallback(() => {
    setCommandHistory([]);
  }, []);

  return {
    // State
    loading,
    lastResult,
    commandHistory,

    // Commands
    sendCommand,
    start,
    stop,
    setFrequency,
    setSpeed,
    resetFault,
    emergencyStop,
    reverse,
    jogForward,
    jogReverse,
    coastStop,
    quickStop,

    // Utilities
    clearHistory,
  };
}

/**
 * Hook for command confirmation dialog
 */
export function useVfdCommandConfirmation() {
  const [isOpen, setIsOpen] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<VfdCommand | null>(null);
  const [commandDescription, setCommandDescription] = useState<string>('');

  const requestConfirmation = useCallback(
    (command: VfdCommand, description?: string) => {
      setPendingCommand(command);
      setCommandDescription(
        description || getCommandDescription(command.command, command.value)
      );
      setIsOpen(true);
    },
    []
  );

  const confirm = useCallback(() => {
    const cmd = pendingCommand;
    setIsOpen(false);
    setPendingCommand(null);
    setCommandDescription('');
    return cmd;
  }, [pendingCommand]);

  const cancel = useCallback(() => {
    setIsOpen(false);
    setPendingCommand(null);
    setCommandDescription('');
  }, []);

  return {
    isOpen,
    pendingCommand,
    commandDescription,
    requestConfirmation,
    confirm,
    cancel,
  };
}

/**
 * Get human-readable command description
 */
export function getCommandDescription(
  command: VfdCommandType,
  value?: number
): string {
  const baseName = VFD_COMMAND_NAMES[command] || command;

  switch (command) {
    case VfdCommandType.SET_FREQUENCY:
      return `Frekansı ${value?.toFixed(1) || 0} Hz olarak ayarla`;
    case VfdCommandType.SET_SPEED:
      return `Hızı %${value?.toFixed(0) || 0} olarak ayarla`;
    case VfdCommandType.START:
      return 'VFD\'yi başlat';
    case VfdCommandType.STOP:
      return 'VFD\'yi durdur';
    case VfdCommandType.EMERGENCY_STOP:
      return 'ACİL DURUŞ - VFD\'yi hemen durdur';
    case VfdCommandType.FAULT_RESET:
      return 'Arıza durumunu sıfırla';
    case VfdCommandType.REVERSE:
      return 'Motor yönünü değiştir';
    case VfdCommandType.JOG_FORWARD:
      return 'İleri yönde jog hareketi';
    case VfdCommandType.JOG_REVERSE:
      return 'Geri yönde jog hareketi';
    case VfdCommandType.COAST_STOP:
      return 'Serbest duruş (Coast Stop)';
    case VfdCommandType.QUICK_STOP:
      return 'Hızlı duruş (Quick Stop)';
    default:
      return baseName;
  }
}

/**
 * Check if command requires confirmation
 */
export function requiresConfirmation(command: VfdCommandType): boolean {
  const criticalCommands = [
    VfdCommandType.START,
    VfdCommandType.EMERGENCY_STOP,
    VfdCommandType.REVERSE,
    VfdCommandType.SET_FREQUENCY,
    VfdCommandType.SET_SPEED,
  ];

  return criticalCommands.includes(command);
}

/**
 * Check if command is destructive/dangerous
 */
export function isDangerousCommand(command: VfdCommandType): boolean {
  return command === VfdCommandType.EMERGENCY_STOP;
}
