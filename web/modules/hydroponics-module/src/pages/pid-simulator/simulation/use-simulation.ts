/**
 * React Hook: Simulation Loop, History, Snapshots
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import {
  SimConfig,
  SimState,
  SimSnapshot,
  PIDParams,
  createInitialSimState,
  createInitialPIDState,
  DEFAULT_SIM_CONFIG,
  DEFAULT_PH_PID,
  DEFAULT_EC_PID,
  DEFAULT_ACID_PUMP,
  DEFAULT_BASE_PUMP,
  DEFAULT_NUT_PUMP,
  ALARM_CODES,
} from './types';
import {
  calcDicOfAlk,
  calcCo2OfDic,
  co2MmToMg,
} from '../engine/carbonate-chemistry';
import { pidStep, ecPidStep } from './pid-controller';
import { plantStep, pumpToGrams, pumpToML } from './plant-model';
import { fsmStep } from './state-machine';
import { safetyCheck } from './safety';

const HISTORY_MAX = 500;
const TRAIL_MAX = 100;
const INTERVAL_MS = 40; // 25 fps

export interface SimHistory {
  snapshots: SimSnapshot[];
  trail: Array<{ CT: number; AT: number }>;
}

const chemFns = { calcDicOfAlk, calcCo2OfDic, co2MmToMg };

export function useSimulation() {
  const [config, setConfig] = useState<SimConfig>({ ...DEFAULT_SIM_CONFIG });
  const [phPIDParams, setPhPIDParams] = useState<PIDParams>({ ...DEFAULT_PH_PID });
  const [ecPIDParams, setEcPIDParams] = useState<PIDParams>({ ...DEFAULT_EC_PID });
  const [running, setRunning] = useState(false);
  const [renderCount, setRenderCount] = useState(0);

  const stateRef = useRef<SimState>(createInitialSimState(config, chemFns));
  const lastSafetyTickRef = useRef<{ value: number }>({ value: 0 });
  const historyRef = useRef<SimSnapshot[]>([]);
  const trailRef = useRef<Array<{ CT: number; AT: number }>>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const takeSnapshot = useCallback((): SimSnapshot => {
    const s = stateRef.current;
    return {
      tick: s.tick,
      DIC: s.DIC,
      ALK: s.ALK,
      pH: s.pH,
      EC: s.EC,
      co2: s.co2,
      acidPump: s.acidPump,
      basePump: s.basePump,
      nutPump: s.nutPump,
      dilPump: s.dilPump,
      state: s.state,
      gainSchedule: s.gainSchedule,
      bufferCapacity: s.bufferCapacity,
      phKp: phPIDParams.Kp * s.gainSchedule,
      phKi: phPIDParams.Ki * s.gainSchedule,
      phKd: phPIDParams.Kd * s.gainSchedule,
      alarmCode: s.alarmCode,
      alarmLatched: s.alarmLatched,
    };
  }, [phPIDParams]);

  const simTick = useCallback(() => {
    const state = stateRef.current;
    const cfg = config;

    if (state.alarmLatched) {
      fsmStep(state, cfg);
      return;
    }

    // 1. FSM determines which pumps are active
    fsmStep(state, cfg);

    // 2. PID controllers set pump output based on FSM state
    if (state.state === 'PH') {
      const phResult = pidStep(
        cfg.targetPH,
        state.pH,
        state.phPID,
        phPIDParams,
        cfg.dt,
        state.gainSchedule,
      );
      state.phPID = phResult.state;
      state.acidPump = phResult.acidPercent;
      state.basePump = phResult.basePercent;
    }

    if (state.state === 'EC') {
      const ecResult = ecPidStep(
        cfg.targetEC,
        state.EC,
        state.ecPID,
        ecPIDParams,
        cfg.dt,
      );
      state.ecPID = ecResult.state;
      state.nutPump = ecResult.nutPercent;
    }

    // 3. Convert pump outputs to physical quantities
    const acidGrams = pumpToGrams(state.acidPump, DEFAULT_ACID_PUMP, cfg.dt);
    const baseGrams = pumpToGrams(state.basePump, DEFAULT_BASE_PUMP, cfg.dt);
    const nutML = pumpToML(state.nutPump, DEFAULT_NUT_PUMP, cfg.dt);

    // 4. Plant model step (thermodynamic)
    plantStep(state, acidGrams, baseGrams, nutML, state.dilPump, cfg);

    // 5. Safety checks
    const alarm = safetyCheck(state, lastSafetyTickRef.current);
    if (alarm !== ALARM_CODES.NONE) {
      state.alarmCode = alarm;
      state.alarmLatched = true;
    }
  }, [config, phPIDParams, ecPIDParams]);

  const runInterval = useCallback(() => {
    const ticksPerInterval = Math.max(1, Math.round(config.speedMultiplier));

    for (let i = 0; i < ticksPerInterval; i++) {
      simTick();
    }

    // Record snapshot
    const snap = takeSnapshot();
    historyRef.current.push(snap);
    if (historyRef.current.length > HISTORY_MAX) {
      historyRef.current.shift();
    }

    // Record trail point
    const s = stateRef.current;
    const dic = calcDicOfAlk(s.ALK, s.pH, config.tempC, config.salinity);
    trailRef.current.push({ CT: dic, AT: s.ALK });
    if (trailRef.current.length > TRAIL_MAX) {
      trailRef.current.shift();
    }

    // Trigger re-render
    setRenderCount(c => c + 1);
  }, [config, simTick, takeSnapshot]);

  // Start/stop interval
  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(runInterval, INTERVAL_MS);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [running, runInterval]);

  const start = useCallback(() => setRunning(true), []);
  const stop = useCallback(() => setRunning(false), []);

  const reset = useCallback(() => {
    setRunning(false);
    stateRef.current = createInitialSimState(config, chemFns);
    lastSafetyTickRef.current = { value: 0 };
    historyRef.current = [];
    trailRef.current = [];
    setRenderCount(c => c + 1);
  }, [config]);

  const acknowledgeAlarm = useCallback(() => {
    const s = stateRef.current;
    s.alarmLatched = false;
    s.alarmCode = ALARM_CODES.NONE;
    s.state = 'IDLE';
    // Cooldown: set stateTimer negative so FSM stays in IDLE for ~300 ticks (30s)
    s.stateTimer = -300;
    s.phPID = createInitialPIDState(s.pH);
    s.ecPID = createInitialPIDState(s.EC);
    // Clear sensor history to prevent stale drift/stuck alarms
    s.phHistory = [];
    s.ecHistory = [];
    setRenderCount(c => c + 1);
  }, []);

  const applyDisturbance = useCallback((type: 'phUp' | 'phDown' | 'ecUp' | 'ecDown') => {
    const s = stateRef.current;
    switch (type) {
      case 'phUp':
        s.ALK += 0.5;
        break;
      case 'phDown':
        s.ALK -= 0.5;
        break;
      case 'ecUp':
        s.EC += 0.3;
        break;
      case 'ecDown':
        s.EC -= 0.3;
        s.EC = Math.max(0.1, s.EC);
        break;
    }
    setRenderCount(c => c + 1);
  }, []);

  return {
    // State
    state: stateRef.current,
    history: historyRef.current,
    trail: trailRef.current,
    running,
    renderCount,

    // Config
    config,
    setConfig,
    phPIDParams,
    setPhPIDParams,
    ecPIDParams,
    setEcPIDParams,

    // Actions
    start,
    stop,
    reset,
    acknowledgeAlarm,
    applyDisturbance,
  };
}
