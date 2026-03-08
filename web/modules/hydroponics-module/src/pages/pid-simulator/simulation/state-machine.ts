/**
 * 8-State FSM for Hydroponics PID Control
 *
 * IDLE -> EC (|ecErr| > 0.08) | pH (|phErr| > 0.12) | DILUTE (ecErr < -0.3)
 * EC -> EC_WAIT (|ecErr| <= 0.06)
 * EC_WAIT -> EC (retry) | CHEM_DT (timer done, EC OK)
 * CHEM_DT -> PH (dead time complete, integral reset)
 * PH -> PH_WAIT (|phErr| <= 0.06)
 * PH_WAIT -> PH (retry) | IDLE (pH OK)
 * ALARM: latching, ACK required
 */

import { SimState, SimConfig, SimStateName, createInitialPIDState } from './types';

const EC_ENTER_THRESH = 0.08;
const EC_EXIT_THRESH = 0.06;
const PH_ENTER_THRESH = 0.12;
const PH_EXIT_THRESH = 0.06;
const EC_DILUTE_THRESH = -0.3;
const EC_WAIT_TICKS = 300;   // 30 seconds at dt=0.1
const CHEM_DT_TICKS = 200;   // 20 seconds dead time
const PH_WAIT_TICKS = 300;   // 30 seconds
const DILUTE_EXIT_THRESH = -0.1;

export function fsmStep(state: SimState, config: SimConfig): void {
  if (state.alarmLatched) {
    state.state = 'ALARM';
    // In ALARM state, all pumps are off
    state.acidPump = 0;
    state.basePump = 0;
    state.nutPump = 0;
    state.dilPump = 0;
    return;
  }

  const ecErr = config.targetEC - state.EC;
  const phErr = config.targetPH - state.pH;
  state.stateTimer++;

  switch (state.state) {
    case 'IDLE':
      // All pumps off in IDLE
      state.acidPump = 0;
      state.basePump = 0;
      state.nutPump = 0;
      state.dilPump = 0;

      // Cooldown: stateTimer can be negative after alarm ACK (post-alarm dwell)
      if (state.stateTimer < 0) break;

      // Priority: DILUTE > EC > pH
      if (ecErr < EC_DILUTE_THRESH) {
        transitionTo(state, 'DILUTE');
      } else if (Math.abs(ecErr) > EC_ENTER_THRESH) {
        transitionTo(state, 'EC');
      } else if (Math.abs(phErr) > PH_ENTER_THRESH) {
        transitionTo(state, 'PH');
      }
      break;

    case 'EC':
      // EC control active, pH pumps off
      state.acidPump = 0;
      state.basePump = 0;
      state.dilPump = 0;
      // nutPump is set by PID controller externally

      if (Math.abs(ecErr) <= EC_EXIT_THRESH) {
        transitionTo(state, 'EC_WAIT');
      }
      break;

    case 'EC_WAIT':
      // Waiting for EC to settle
      state.nutPump = 0;
      state.acidPump = 0;
      state.basePump = 0;
      state.dilPump = 0;

      if (Math.abs(ecErr) > EC_ENTER_THRESH) {
        // EC drifted back out, retry
        transitionTo(state, 'EC');
      } else if (state.stateTimer >= EC_WAIT_TICKS) {
        transitionTo(state, 'CHEM_DT');
      }
      break;

    case 'CHEM_DT':
      // Chemical dead time - everything off, waiting for chemistry to equilibrate
      state.acidPump = 0;
      state.basePump = 0;
      state.nutPump = 0;
      state.dilPump = 0;

      if (state.stateTimer >= CHEM_DT_TICKS) {
        // Reset pH PID before entering PH state (use current pH to avoid derivative kick)
        state.phPID = createInitialPIDState(state.pH);
        transitionTo(state, 'PH');
      }
      break;

    case 'PH':
      // pH control active, nutrient pump off
      state.nutPump = 0;
      state.dilPump = 0;
      // acidPump and basePump set by PID controller externally

      if (Math.abs(phErr) <= PH_EXIT_THRESH) {
        transitionTo(state, 'PH_WAIT');
      }
      break;

    case 'PH_WAIT':
      // Waiting for pH to settle
      state.acidPump = 0;
      state.basePump = 0;
      state.nutPump = 0;
      state.dilPump = 0;

      if (Math.abs(phErr) > PH_ENTER_THRESH) {
        transitionTo(state, 'PH');
      } else if (state.stateTimer >= PH_WAIT_TICKS) {
        transitionTo(state, 'IDLE');
      }
      break;

    case 'DILUTE':
      // Dilution active
      state.acidPump = 0;
      state.basePump = 0;
      state.nutPump = 0;
      state.dilPump = 80; // Fixed dilution rate

      if (ecErr >= DILUTE_EXIT_THRESH) {
        transitionTo(state, 'IDLE');
      }
      break;

    case 'ALARM':
      state.acidPump = 0;
      state.basePump = 0;
      state.nutPump = 0;
      state.dilPump = 0;
      break;
  }
}

function transitionTo(state: SimState, newState: SimStateName): void {
  state.state = newState;
  state.stateTimer = 0;
}
