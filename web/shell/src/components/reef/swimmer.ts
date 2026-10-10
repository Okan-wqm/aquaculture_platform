/**
 * Swimmer — burst-and-coast swimming for one reef fish.
 *
 * Each fish alternates a burst (accelerate toward vmax) and a coast (drift at
 * a fraction of it), steers toward a wandering target with a bounded turn
 * rate, beats its tail faster the faster it goes, banks (pitches) with its
 * vertical velocity and turns to face its direction of travel. Fish that
 * leave the stage respawn on a random edge.
 */
import { PLANES, SPECIES, type PlaneKey, type SpeciesKey, type SpeciesSpec } from './species';

export const rand = (a: number, b: number): number => a + Math.random() * (b - a);

/** px kept clear for the sea floor when choosing an open-water depth */
const FLOOR_CLEARANCE = 160;

export class Swimmer {
  readonly sp: SpeciesSpec;
  readonly plane: PlaneKey;
  readonly w: number;
  readonly h: number;
  vmax: number;
  x: number;
  y: number;
  heading: number;
  spd: number;
  faceCur: number;
  pitch = 0;
  phase: number;
  tailA = 0;
  tx = 0;
  ty = 0;
  burst = false;
  modeLeft = 0;
  el: HTMLElement | null = null;
  pitchEl: SVGGElement | null = null;
  tailEl: SVGGElement | null = null;

  constructor(species: SpeciesKey, plane: PlaneKey, W: number, H: number) {
    this.sp = SPECIES[species];
    this.plane = plane;
    const z = PLANES[plane];
    this.w = this.sp.baseW * z * rand(0.88, 1.12);
    this.h = this.w * this.sp.ar;
    this.vmax = this.sp.vmax * (0.5 + z * 0.6);
    this.x = rand(0, W);
    this.y = this.bandY(H);
    this.heading = Math.random() > 0.5 ? 0 : Math.PI;
    this.spd = this.vmax * 0.3;
    this.faceCur = Math.cos(this.heading) >= 0 ? 1 : -1;
    this.phase = rand(0, Math.PI * 2);
    this.newTarget(W, H);
    this.newMode();
  }

  bandY(H: number): number {
    if (this.sp.band === 'upper') return rand(H * 0.04, H * 0.42);
    if (this.sp.band === 'bottom') return Math.max(H * 0.5, rand(H - 215, H - 155) - this.h * 0.5);
    return rand(H * 0.06, Math.max(H * 0.1, H - FLOOR_CLEARANCE - this.h - 30));
  }

  newTarget(W: number, H: number): void {
    if (Math.random() < (this.sp.exitBias ?? 0.24)) {
      this.tx = this.faceCur > 0 ? W + this.w + 120 : -this.w - 120;
    } else {
      this.tx = rand(W * 0.05, W * 0.95);
    }
    this.ty = this.bandY(H);
  }

  newMode(): void {
    this.burst = !this.burst;
    const [lo, hi] = this.burst ? this.sp.burst : this.sp.coast;
    this.modeLeft = rand(lo, hi);
  }

  respawn(W: number, H: number): void {
    const fromLeft = Math.random() > 0.5;
    this.x = fromLeft ? -this.w - 60 : W + this.w + 60;
    this.y = this.bandY(H);
    this.heading = fromLeft ? 0 : Math.PI;
    this.faceCur = fromLeft ? 1 : -1;
    this.tx = fromLeft ? W + this.w + 120 : -this.w - 120;
    this.ty = this.bandY(H);
  }

  step(dt: number, W: number, H: number): void {
    this.modeLeft -= dt;
    if (this.modeLeft <= 0) this.newMode();
    const targetSpd = this.burst ? this.vmax : this.vmax * this.sp.coastFrac;
    this.spd += (targetSpd - this.spd) * Math.min(1, dt * (this.burst ? 4.5 : 1.6));

    const want = Math.atan2(this.ty - this.y, this.tx - this.x);
    let dh = want - this.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const maxTurn = this.sp.turn * dt;
    this.heading += Math.max(-maxTurn, Math.min(maxTurn, dh));

    const vx = Math.cos(this.heading) * this.spd;
    const vy = Math.sin(this.heading) * this.spd;
    this.x += vx * dt;
    this.y += vy * dt + Math.sin(this.phase * 0.35) * this.sp.bob * dt;

    const face = Math.abs(vx) > 6 ? Math.sign(vx) : this.faceCur >= 0 ? 1 : -1;
    this.faceCur += (face - this.faceCur) * Math.min(1, dt * 3.2);

    const speedRatio = this.spd / this.vmax;
    this.phase += dt * Math.PI * 2 * (0.7 + speedRatio * this.sp.tailK);
    this.tailA = (2.5 + this.sp.amp * speedRatio) * Math.sin(this.phase);

    const pm = this.sp.pitchMax;
    const targetPitch = Math.max(-pm, Math.min(pm, Math.atan2(vy, Math.abs(vx) + 4) * 57.3 * 0.7));
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 4);

    const dx = this.tx - this.x;
    const dy = this.ty - this.y;
    if (dx * dx + dy * dy < 3600) this.newTarget(W, H);
    if (this.x < -this.w - 200 || this.x > W + this.w + 200) this.respawn(W, H);
    if (this.y < 10) this.y = 10;
  }

  apply(): void {
    if (!this.el || !this.pitchEl || !this.tailEl) return;
    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px,${this.y.toFixed(1)}px,0) scale(${this.faceCur.toFixed(3)},1)`;
    this.pitchEl.style.transform = `rotate(${(this.pitch - this.tailA * 0.14).toFixed(2)}deg)`;
    this.tailEl.style.transform = `rotate(${this.tailA.toFixed(2)}deg)`;
  }
}
