/**
 * <suderra-reef-scene> — the underwater scene behind the auth card
 * (FE-HIGH-313; replaces FishBackground).
 *
 * WHAT: a self-contained custom element in its own shadow root: aquaculture
 * species (salmon, sea bass, gilt-head bream, trout, mackerel, turbot, tuna)
 * swimming burst-and-coast on three depth planes, a baitfish school orbiting
 * a wandering anchor, swaying kelp and eelgrass, god rays, marine snow,
 * caustic dapple and vent bubbles.
 *
 * WHY a custom element and not React state: the scene moves ~40 transforms
 * every animation frame; keeping it outside React avoids reconciling the tree
 * sixty times a second, and the shadow root keeps its stylesheet off the page.
 *
 * Attributes: `density` = low | med | high (roster size), `plants="false"`
 * hides the plant layer. Under `prefers-reduced-motion: reduce` it paints one
 * still frame and starts no animation loop; the CSS stops every keyframe.
 */
import floorSvg from './art/floor.svg?raw';
import { plantLayer } from './plants';
import sceneCss from './reefScene.css?raw';
import {
  BAIT_ART,
  ROSTERS,
  SCHOOL_SIZE,
  SPECIES,
  isReefDensity,
  speciesArt,
  type ReefDensity,
} from './species';
import { Swimmer, rand } from './swimmer';

export const REEF_SCENE_TAG = 'suderra-reef-scene';

interface SchoolMember {
  el: HTMLElement;
  ox: number;
  oy: number;
  p1: number;
  p2: number;
  w1: number;
  w2: number;
  s: number;
}

const FALLBACK_SIZE = { W: 1440, H: 900 };

function spans(count: number, style: () => string): string {
  return Array.from({ length: count }, () => `<span style="${style()}"></span>`).join('');
}

function snowMarkup(): string {
  return spans(42, () => {
    const s = rand(1, 3).toFixed(1);
    return `left:${rand(0, 100).toFixed(1)}%;top:${rand(0, 100).toFixed(1)}%;width:${s}px;height:${s}px;opacity:${rand(0.12, 0.4).toFixed(2)};animation-duration:${rand(14, 34).toFixed(1)}s;animation-delay:${(-rand(0, 20)).toFixed(1)}s`;
  });
}

function bubbleMarkup(): string {
  const vents = (
    [
      [17, 5],
      [47, 3],
      [76, 5],
    ] as const
  )
    .map(([x, n]) =>
      spans(n, () => {
        const s = rand(2.5, 7).toFixed(1);
        return `left:calc(${x}% + ${rand(-14, 14).toFixed(0)}px);width:${s}px;height:${s}px;animation-duration:${rand(6.5, 11).toFixed(1)}s;animation-delay:${(-rand(0, 11)).toFixed(1)}s`;
      }),
    )
    .join('');
  const singles = spans(6, () => {
    const s = rand(2, 5).toFixed(1);
    return `left:${rand(4, 96).toFixed(0)}%;width:${s}px;height:${s}px;animation-duration:${rand(9, 15).toFixed(1)}s;animation-delay:${(-rand(0, 14)).toFixed(1)}s`;
  });
  return vents + singles;
}

function sceneMarkup(): string {
  return `<style>${sceneCss}</style><div class="bg">
    <div class="layer rays"><div class="ray ray-1"></div><div class="ray ray-2"></div><div class="ray ray-3"></div><div class="ray ray-4"></div></div>
    <div class="layer snow">${snowMarkup()}</div>
    <div class="layer school-far"></div>
    <div class="layer fish-back"></div>
    ${floorSvg}
    <div class="caustic ca1"></div><div class="caustic ca2"></div>
    <div class="layer plants">${plantLayer()}</div>
    <div class="layer fish-front"></div>
    <div class="layer bubbles">${bubbleMarkup()}</div>
    <div class="tint"></div><div class="vignette"></div>
  </div>`;
}

export class ReefSceneElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['density', 'plants'];
  }

  private built = false;
  private plantsLayer: HTMLElement | null = null;
  private back: HTMLElement | null = null;
  private front: HTMLElement | null = null;
  private schoolLayer: HTMLElement | null = null;
  private dims = FALLBACK_SIZE;
  private resizeObserver: ResizeObserver | null = null;
  private motionQuery: MediaQueryList | null = null;
  private readonly onMotionChange = (): void => this.start();
  private fish: Swimmer[] = [];
  private anchor: Swimmer | null = null;
  private members: SchoolMember[] = [];
  private t = 0;
  private raf: number | null = null;

  attributeChangedCallback(name: string): void {
    if (!this.built) return;
    if (name === 'density') this.buildFish();
    if (name === 'plants') this.applyPlants();
  }

  connectedCallback(): void {
    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.motionQuery.addEventListener('change', this.onMotionChange);
    this.resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) this.dims = { W: rect.width, H: rect.height };
    });
    this.resizeObserver.observe(this);
    // build() ends in buildFish(), which starts the loop; a re-attached scene only restarts it.
    if (this.built) this.start();
    else this.build();
  }

  disconnectedCallback(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.motionQuery?.removeEventListener('change', this.onMotionChange);
    this.motionQuery = null;
  }

  /** True while an animation frame is scheduled — reduced motion keeps it false. */
  get animating(): boolean {
    return this.raf !== null;
  }

  private build(): void {
    this.built = true;
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.innerHTML = sceneMarkup();
    this.plantsLayer = root.querySelector<HTMLElement>('.plants');
    this.back = root.querySelector<HTMLElement>('.fish-back');
    this.front = root.querySelector<HTMLElement>('.fish-front');
    this.schoolLayer = root.querySelector<HTMLElement>('.school-far');
    this.dims = {
      W: this.offsetWidth || FALLBACK_SIZE.W,
      H: this.offsetHeight || FALLBACK_SIZE.H,
    };
    this.applyPlants();
    this.buildFish();
  }

  private applyPlants(): void {
    if (this.plantsLayer) {
      this.plantsLayer.style.display = this.getAttribute('plants') === 'false' ? 'none' : '';
    }
  }

  // Not named `density`: React 19 assigns a prop to a same-named element property.
  private currentDensity(): ReefDensity {
    const value = this.getAttribute('density');
    return isReefDensity(value) ? value : 'med';
  }

  private buildFish(): void {
    const { back, front, schoolLayer } = this;
    if (!back || !front || !schoolLayer) return;
    const { W, H } = this.dims;
    const density = this.currentDensity();
    back.replaceChildren();
    front.replaceChildren();
    schoolLayer.replaceChildren();
    let uid = 1000;

    this.fish = ROSTERS[density].map(([species, plane]) => {
      const swimmer = new Swimmer(species, plane, W, H);
      const el = document.createElement('div');
      el.className = `fish p-${plane}`;
      el.style.width = `${swimmer.w}px`;
      el.style.height = `${swimmer.h}px`;
      uid += 1;
      el.innerHTML = speciesArt(SPECIES[species].art, uid);
      const pect = el.querySelector<SVGGElement>('.pectg');
      if (pect) pect.style.animationDelay = `${(-rand(0, 1.7)).toFixed(2)}s`;
      (plane === 'near' ? front : back).appendChild(el);
      swimmer.el = el;
      swimmer.pitchEl = el.querySelector<SVGGElement>('.pitchg');
      swimmer.tailEl = el.querySelector<SVGGElement>('.tailg');
      return swimmer;
    });

    // The baitfish school orbits an invisible anchor that swims like a bass.
    this.anchor = new Swimmer('bass', 'far', W, H);
    this.anchor.vmax = 62;
    this.members = Array.from({ length: SCHOOL_SIZE[density] }, () => {
      const el = document.createElement('div');
      el.className = 'fish p-far';
      const w = rand(26, 42);
      el.style.width = `${w}px`;
      el.style.height = `${w * 0.28}px`;
      uid += 1;
      el.innerHTML = speciesArt(BAIT_ART, uid);
      const tail = el.querySelector<SVGGElement>('.baittail');
      if (tail) tail.style.animationDelay = `${(-rand(0, 0.5)).toFixed(2)}s`;
      schoolLayer.appendChild(el);
      return {
        el,
        ox: rand(-78, 78),
        oy: rand(-26, 26),
        p1: rand(0, 6.3),
        p2: rand(0, 6.3),
        w1: rand(0.8, 1.6),
        w2: rand(0.7, 1.4),
        s: rand(0.85, 1.15),
      };
    });
    this.t = 0;
    // One synchronous frame, so the scene is laid out before the first rAF
    // (and is the still frame under reduced motion); then (re)start while connected.
    this.paint();
    if (this.motionQuery) this.start();
  }

  private paint(): void {
    for (const swimmer of this.fish) swimmer.apply();
    const anchor = this.anchor;
    if (!anchor) return;
    for (const m of this.members) {
      const jx = Math.sin(this.t * m.w1 + m.p1) * 8;
      const jy = Math.cos(this.t * m.w2 + m.p2) * 5;
      m.el.style.transform = `translate3d(${(anchor.x + m.ox + jx).toFixed(1)}px,${(anchor.y + m.oy + jy).toFixed(1)}px,0) scale(${(anchor.faceCur * m.s).toFixed(3)},${m.s.toFixed(3)})`;
    }
  }

  private stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private start(): void {
    this.stop();
    if (this.fish.length === 0) return;
    if (this.motionQuery?.matches) {
      this.paint();
      return;
    }
    let last = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.t += dt;
      const { W, H } = this.dims;
      for (const swimmer of this.fish) swimmer.step(dt, W, H);
      this.anchor?.step(dt, W, H);
      this.paint();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
}

/** Registers the element once; safe to call from every importer. */
export function defineReefScene(): void {
  if (typeof window !== 'undefined' && !window.customElements.get(REEF_SCENE_TAG)) {
    window.customElements.define(REEF_SCENE_TAG, ReefSceneElement);
  }
}
