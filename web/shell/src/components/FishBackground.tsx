/**
 * Fish Background Component
 *
 * Aquarium-style fish animation for the login page.
 * Uses imperative DOM updates via requestAnimationFrame to avoid
 * 60fps React state updates and unnecessary reconciliation.
 * Dimensions are tracked with ResizeObserver to handle window resizes.
 */

import React, { useEffect, useRef } from 'react';

// ============================================================================
// Fish SVG Components — unique gradient IDs per fish instance
// ============================================================================

const SeaBass: React.FC<{ fishId: number }> = ({ fishId }) => (
  <svg viewBox="0 0 120 50" style={{ width: '100%', height: '100%' }}>
    <defs>
      <linearGradient id={`seabass-body-${fishId}`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="rgba(70,80,90,0.5)" />
        <stop offset="40%" stopColor="rgba(180,190,200,0.45)" />
        <stop offset="100%" stopColor="rgba(220,225,230,0.4)" />
      </linearGradient>
    </defs>
    <ellipse cx="55" cy="25" rx="42" ry="16" fill={`url(#seabass-body-${fishId})`} />
    <g className="fish-tail">
      <path d="M13 25 L2 10 Q0 25 2 40 L13 25" fill="rgba(100,110,120,0.45)" />
    </g>
    <path d="M40 9 Q55 4 75 9 Q70 12 55 11 Q45 11 40 9" fill="rgba(60,70,80,0.5)" />
    <path d="M65 30 Q72 38 68 42 Q62 38 65 30" fill="rgba(150,160,170,0.4)" />
    <path d="M20 25 Q55 23 90 25" stroke="rgba(200,210,220,0.3)" strokeWidth="1" fill="none" />
    <path d="M75 18 Q78 25 75 32" stroke="rgba(180,100,100,0.3)" strokeWidth="2" fill="none" />
    <circle cx="92" cy="22" r="5" fill="rgba(255,255,255,0.9)" />
    <circle cx="93" cy="21" r="2.5" fill="rgba(20,20,20,0.9)" />
    <circle cx="94" cy="20" r="1" fill="rgba(255,255,255,0.8)" />
  </svg>
);

const SeaBream: React.FC<{ fishId: number }> = ({ fishId }) => (
  <svg viewBox="0 0 100 60" style={{ width: '100%', height: '100%' }}>
    <defs>
      <linearGradient id={`bream-body-${fishId}`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="rgba(80,90,100,0.5)" />
        <stop offset="30%" stopColor="rgba(200,180,140,0.45)" />
        <stop offset="70%" stopColor="rgba(220,200,160,0.4)" />
        <stop offset="100%" stopColor="rgba(240,230,200,0.35)" />
      </linearGradient>
    </defs>
    <ellipse cx="45" cy="30" rx="35" ry="22" fill={`url(#bream-body-${fishId})`} />
    <g className="fish-tail">
      <path d="M10 30 L0 12 Q-2 30 0 48 L10 30" fill="rgba(180,160,120,0.45)" />
    </g>
    <path d="M30 8 Q45 2 65 8 Q58 14 45 12 Q35 12 30 8" fill="rgba(100,90,70,0.5)" />
    <path d="M35 52 Q45 58 55 52 Q48 50 40 50 L35 52" fill="rgba(200,180,140,0.4)" />
    <path d="M15 30 Q45 28 75 30" stroke="rgba(255,215,0,0.25)" strokeWidth="3" fill="none" />
    <path d="M62 20 Q66 30 62 40" stroke="rgba(200,120,120,0.3)" strokeWidth="2" fill="none" />
    <circle cx="72" cy="26" r="6" fill="rgba(255,255,255,0.9)" />
    <circle cx="73" cy="25" r="3" fill="rgba(20,20,20,0.9)" />
    <circle cx="74" cy="24" r="1.2" fill="rgba(255,255,255,0.8)" />
  </svg>
);

const Salmon: React.FC<{ fishId: number }> = ({ fishId }) => (
  <svg viewBox="0 0 140 55" style={{ width: '100%', height: '100%' }}>
    <defs>
      <linearGradient id={`salmon-body-${fishId}`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="rgba(70,90,100,0.5)" />
        <stop offset="40%" stopColor="rgba(200,180,190,0.45)" />
        <stop offset="100%" stopColor="rgba(240,200,200,0.4)" />
      </linearGradient>
    </defs>
    <ellipse cx="65" cy="27" rx="55" ry="18" fill={`url(#salmon-body-${fishId})`} />
    <g className="fish-tail">
      <path d="M10 27 L-2 8 Q-5 27 -2 46 L10 27" fill="rgba(150,130,140,0.45)" />
    </g>
    <path d="M50 9 Q70 4 90 9 Q82 14 65 12 Q55 12 50 9" fill="rgba(80,100,110,0.5)" />
    <ellipse cx="30" cy="12" rx="6" ry="4" fill="rgba(180,160,170,0.4)" />
    <path d="M85 35 Q95 45 90 50 Q82 42 85 35" fill="rgba(200,180,190,0.4)" />
    <circle cx="40" cy="22" r="2.5" fill="rgba(50,50,50,0.25)" />
    <circle cx="55" cy="18" r="2" fill="rgba(50,50,50,0.2)" />
    <circle cx="70" cy="24" r="2.2" fill="rgba(50,50,50,0.25)" />
    <circle cx="85" cy="20" r="1.8" fill="rgba(50,50,50,0.2)" />
    <path d="M15 27 Q65 25 115 27" stroke="rgba(255,150,150,0.2)" strokeWidth="4" fill="none" />
    <path d="M95 16 Q100 27 95 38" stroke="rgba(220,150,150,0.35)" strokeWidth="2" fill="none" />
    <circle cx="115" cy="24" r="5" fill="rgba(255,255,255,0.9)" />
    <circle cx="116" cy="23" r="2.5" fill="rgba(20,20,20,0.9)" />
    <circle cx="117" cy="22" r="1" fill="rgba(255,255,255,0.8)" />
  </svg>
);

const Halibut: React.FC<{ fishId: number }> = ({ fishId }) => (
  <svg viewBox="0 0 130 40" style={{ width: '100%', height: '100%' }}>
    <defs>
      <linearGradient id={`halibut-body-${fishId}`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="rgba(100,80,60,0.5)" />
        <stop offset="50%" stopColor="rgba(160,140,110,0.45)" />
        <stop offset="100%" stopColor="rgba(220,210,190,0.35)" />
      </linearGradient>
    </defs>
    <ellipse cx="60" cy="20" rx="50" ry="14" fill={`url(#halibut-body-${fishId})`} />
    <g className="fish-tail">
      <path d="M10 20 L0 8 Q-2 20 0 32 L10 20" fill="rgba(130,110,80,0.45)" />
    </g>
    <path d="M20 6 Q60 2 100 6 Q90 10 60 9 Q30 9 20 6" fill="rgba(120,100,70,0.45)" />
    <path d="M20 34 Q60 38 100 34 Q90 30 60 31 Q30 31 20 34" fill="rgba(180,160,130,0.4)" />
    <circle cx="40" cy="18" r="3" fill="rgba(80,60,40,0.15)" />
    <circle cx="60" cy="15" r="4" fill="rgba(80,60,40,0.12)" />
    <circle cx="80" cy="20" r="3.5" fill="rgba(80,60,40,0.15)" />
    <path d="M85 12 Q90 20 85 28" stroke="rgba(180,140,140,0.3)" strokeWidth="1.5" fill="none" />
    <circle cx="105" cy="14" r="4.5" fill="rgba(255,255,255,0.9)" />
    <circle cx="106" cy="13" r="2.2" fill="rgba(20,20,20,0.9)" />
    <circle cx="107" cy="12" r="0.9" fill="rgba(255,255,255,0.8)" />
  </svg>
);

const Wrasse: React.FC<{ fishId: number }> = ({ fishId }) => (
  <svg viewBox="0 0 80 40" style={{ width: '100%', height: '100%' }}>
    <defs>
      <linearGradient id={`wrasse-body-${fishId}`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="rgba(60,150,130,0.5)" />
        <stop offset="50%" stopColor="rgba(100,180,200,0.45)" />
        <stop offset="100%" stopColor="rgba(200,150,100,0.4)" />
      </linearGradient>
    </defs>
    <ellipse cx="38" cy="20" rx="28" ry="14" fill={`url(#wrasse-body-${fishId})`} />
    <g className="fish-tail">
      <path d="M10 20 L2 8 Q0 20 2 32 L10 20" fill="rgba(80,160,140,0.45)" />
    </g>
    <path d="M20 6 Q38 2 56 6 Q48 10 35 9 Q25 9 20 6" fill="rgba(220,120,80,0.45)" />
    <path d="M48 26 Q54 34 50 36 Q45 30 48 26" fill="rgba(100,200,180,0.4)" />
    <path d="M15 20 Q38 18 60 20" stroke="rgba(255,180,100,0.25)" strokeWidth="3" fill="none" />
    <path d="M18 15 Q38 13 55 15" stroke="rgba(100,200,220,0.2)" strokeWidth="2" fill="none" />
    <path d="M52 14 Q55 20 52 26" stroke="rgba(200,130,130,0.3)" strokeWidth="1" fill="none" />
    <circle cx="62" cy="18" r="4.5" fill="rgba(255,255,255,0.9)" />
    <circle cx="63" cy="17" r="2.2" fill="rgba(20,20,20,0.9)" />
    <circle cx="64" cy="16" r="0.9" fill="rgba(255,255,255,0.8)" />
  </svg>
);

type FishComponentType = React.FC<{ fishId: number }>;
const FishComponents: FishComponentType[] = [SeaBass, SeaBream, Salmon, Halibut, Wrasse];

// ============================================================================
// Sea Floor Decorations (static, no animation)
// ============================================================================

const BranchCoral: React.FC<{ color: string; x: number; scale?: number }> = ({ color, x, scale = 1 }) => (
  <g transform={`translate(${x}, 0) scale(${scale})`}>
    <path d="M20 100 Q20 70 15 50 Q10 30 5 20 Q0 10 5 5" stroke={color} strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M20 100 Q25 75 30 55 Q35 35 40 25" stroke={color} strokeWidth="3.5" fill="none" strokeLinecap="round" />
    <path d="M20 100 Q22 80 28 65 Q35 50 45 40 Q50 35 55 32" stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" />
    <path d="M15 50 Q8 45 3 35" stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M30 55 Q38 48 45 45" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" />
    <circle cx="5" cy="5" r="4" fill={color} />
    <circle cx="40" cy="25" r="3.5" fill={color} />
    <circle cx="55" cy="32" r="3" fill={color} />
    <circle cx="3" cy="35" r="3" fill={color} />
    <circle cx="45" cy="45" r="2.5" fill={color} />
  </g>
);

const BrainCoral: React.FC<{ color: string; x: number; scale?: number }> = ({ color, x, scale = 1 }) => (
  <g transform={`translate(${x}, 0) scale(${scale})`}>
    <ellipse cx="30" cy="85" rx="28" ry="18" fill={color} opacity="0.9" />
    <ellipse cx="30" cy="82" rx="24" ry="14" fill={color} opacity="0.7" />
    <path d="M10 82 Q18 78 25 82 Q32 86 40 82 Q48 78 50 82" stroke={color} strokeWidth="2" fill="none" opacity="0.5" />
    <path d="M15 88 Q22 84 30 88 Q38 92 45 88" stroke={color} strokeWidth="1.5" fill="none" opacity="0.4" />
  </g>
);

const TubeCoral: React.FC<{ color: string; x: number; scale?: number }> = ({ color, x, scale = 1 }) => (
  <g transform={`translate(${x}, 0) scale(${scale})`}>
    {[0, 8, 16, 24, 32].map((offset, i) => (
      <g key={i}>
        <path d={`M${10 + offset} 100 Q${12 + offset} ${70 - i * 5} ${10 + offset} ${50 - i * 8}`} stroke={color} strokeWidth="5" fill="none" strokeLinecap="round" />
        <circle cx={10 + offset} cy={48 - i * 8} r="4" fill={color} opacity="0.8" />
      </g>
    ))}
  </g>
);

const FanCoral: React.FC<{ color: string; x: number; scale?: number }> = ({ color, x, scale = 1 }) => (
  <g transform={`translate(${x}, 0) scale(${scale})`}>
    <path d="M25 100 L25 70" stroke={color} strokeWidth="4" strokeLinecap="round" />
    <path d="M25 70 Q5 50 10 25 Q15 10 25 5 Q35 10 40 25 Q45 50 25 70" fill={color} opacity="0.6" />
    <path d="M25 70 Q15 45 15 25" stroke={color} strokeWidth="1" fill="none" opacity="0.4" />
    <path d="M25 70 Q20 50 18 30" stroke={color} strokeWidth="1" fill="none" opacity="0.4" />
    <path d="M25 70 Q30 50 32 30" stroke={color} strokeWidth="1" fill="none" opacity="0.4" />
    <path d="M25 70 Q35 45 35 25" stroke={color} strokeWidth="1" fill="none" opacity="0.4" />
  </g>
);

const Kelp: React.FC<{ color: string; x: number; height: number; delay?: number }> = ({ color, x, height, delay = 0 }) => (
  <g transform={`translate(${x}, 0)`}>
    <path d={`M10 100 Q5 ${100 - height * 0.3} 12 ${100 - height * 0.5} Q20 ${100 - height * 0.7} 8 ${100 - height * 0.85} Q0 ${100 - height} 10 ${100 - height}`} stroke={color} strokeWidth="6" fill="none" strokeLinecap="round" className="kelp-strand" style={{ animationDelay: `${delay}s` }} />
    <ellipse cx="12" cy={100 - height * 0.5} rx="8" ry="4" fill={color} opacity="0.7" transform={`rotate(-20, 12, ${100 - height * 0.5})`} />
    <ellipse cx="8" cy={100 - height * 0.7} rx="7" ry="3.5" fill={color} opacity="0.7" transform={`rotate(15, 8, ${100 - height * 0.7})`} />
    <ellipse cx="10" cy={100 - height * 0.9} rx="6" ry="3" fill={color} opacity="0.6" transform={`rotate(-10, 10, ${100 - height * 0.9})`} />
  </g>
);

const Seaweed: React.FC<{ color: string; x: number; height: number }> = ({ color, x, height }) => (
  <g transform={`translate(${x}, 0)`}>
    <path d={`M8 100 Q4 ${100 - height * 0.4} 10 ${100 - height * 0.7} Q14 ${100 - height} 8 ${100 - height}`} stroke={color} strokeWidth="4" fill="none" strokeLinecap="round" className="seaweed-strand" />
    <path d={`M16 100 Q20 ${100 - height * 0.35} 14 ${100 - height * 0.6} Q10 ${100 - height * 0.8} 16 ${100 - height * 0.85}`} stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" className="seaweed-strand" style={{ animationDelay: '0.3s' }} />
  </g>
);

const SeaFloor: React.FC = () => (
  <svg className="absolute bottom-0 left-0 w-full" style={{ height: '120px' }} viewBox="0 0 1200 120" preserveAspectRatio="xMidYMax slice">
    <rect x="0" y="100" width="1200" height="20" fill="rgba(194,178,128,0.15)" />
    <ellipse cx="100" cy="105" rx="80" ry="8" fill="rgba(194,178,128,0.1)" />
    <ellipse cx="400" cy="108" rx="120" ry="10" fill="rgba(194,178,128,0.12)" />
    <ellipse cx="800" cy="106" rx="100" ry="9" fill="rgba(194,178,128,0.1)" />
    <ellipse cx="1100" cy="107" rx="90" ry="8" fill="rgba(194,178,128,0.11)" />
    <BranchCoral color="rgba(255,100,100,0.35)" x={50} scale={0.9} />
    <BrainCoral color="rgba(255,150,200,0.3)" x={120} scale={1.1} />
    <TubeCoral color="rgba(255,200,100,0.35)" x={200} scale={0.8} />
    <FanCoral color="rgba(200,100,255,0.3)" x={320} scale={1} />
    <BranchCoral color="rgba(255,180,100,0.35)" x={420} scale={0.7} />
    <BrainCoral color="rgba(100,200,200,0.3)" x={500} scale={0.9} />
    <TubeCoral color="rgba(255,120,150,0.35)" x={600} scale={1} />
    <FanCoral color="rgba(150,255,150,0.3)" x={700} scale={0.85} />
    <BranchCoral color="rgba(255,100,150,0.35)" x={800} scale={1.1} />
    <BrainCoral color="rgba(255,200,150,0.3)" x={900} scale={0.8} />
    <TubeCoral color="rgba(100,180,255,0.35)" x={1000} scale={0.9} />
    <FanCoral color="rgba(255,150,100,0.3)" x={1100} scale={1} />
    <Kelp color="rgba(50,150,80,0.4)" x={30} height={70} delay={0} />
    <Kelp color="rgba(80,180,100,0.35)" x={180} height={85} delay={0.5} />
    <Seaweed color="rgba(60,140,90,0.4)" x={280} height={45} />
    <Kelp color="rgba(40,160,70,0.4)" x={380} height={90} delay={1} />
    <Seaweed color="rgba(70,150,80,0.35)" x={460} height={40} />
    <Kelp color="rgba(90,170,110,0.4)" x={550} height={75} delay={0.3} />
    <Seaweed color="rgba(50,140,70,0.4)" x={650} height={50} />
    <Kelp color="rgba(60,160,90,0.35)" x={750} height={95} delay={0.8} />
    <Seaweed color="rgba(80,150,100,0.4)" x={850} height={35} />
    <Kelp color="rgba(70,180,80,0.4)" x={950} height={80} delay={0.2} />
    <Seaweed color="rgba(55,145,85,0.35)" x={1050} height={55} />
    <Kelp color="rgba(85,165,95,0.4)" x={1150} height={70} delay={0.6} />
  </svg>
);

// ============================================================================
// Fish Physics
// ============================================================================

const FishTraits = {
  0: { speed: 0.72, speedVariance: 0.32, sizeMin: 70, sizeMax: 110, wobbleSpeed: 0.035 },
  1: { speed: 0.48, speedVariance: 0.20, sizeMin: 80, sizeMax: 120, wobbleSpeed: 0.025 },
  2: { speed: 1.12, speedVariance: 0.48, sizeMin: 90, sizeMax: 150, wobbleSpeed: 0.05 },
  3: { speed: 0.32, speedVariance: 0.12, sizeMin: 100, sizeMax: 160, wobbleSpeed: 0.018 },
  4: { speed: 0.88, speedVariance: 0.40, sizeMin: 50, sizeMax: 80, wobbleSpeed: 0.06 },
};

interface FishState {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  type: number;
  facingRight: boolean;
  targetX: number;
  targetY: number;
  speed: number;
  wobble: number;
  wobbleSpeed: number;
}

function createFish(id: number, width: number, height: number): FishState {
  const type = Math.floor(Math.random() * FishComponents.length);
  const traits = FishTraits[type as keyof typeof FishTraits];
  const size = traits.sizeMin + Math.random() * (traits.sizeMax - traits.sizeMin);
  const startFromLeft = Math.random() > 0.5;
  const x = startFromLeft ? -size : width + size;
  const y = 60 + Math.random() * (height - 120);
  return {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    size,
    type,
    facingRight: !startFromLeft,
    targetX: startFromLeft ? width + size + 300 : -size - 300,
    targetY: 60 + Math.random() * (height - 120),
    speed: traits.speed + Math.random() * traits.speedVariance,
    wobble: Math.random() * Math.PI * 2,
    wobbleSpeed: traits.wobbleSpeed + Math.random() * 0.005,
  };
}

function stepFish(fish: FishState, width: number, height: number): FishState {
  const dx = fish.targetX - fish.x;
  const dy = fish.targetY - fish.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const ax = (dx / dist) * fish.speed * 0.05;
  const ay = (dy / dist) * fish.speed * 0.03;

  let newVx = (fish.vx + ax) * 0.995;
  let newVy = (fish.vy + ay) * 0.995;

  const currentSpeed = Math.sqrt(newVx * newVx + newVy * newVy);
  if (currentSpeed > fish.speed) {
    newVx = (newVx / currentSpeed) * fish.speed;
    newVy = (newVy / currentSpeed) * fish.speed;
  }

  const newWobble = fish.wobble + fish.wobbleSpeed;
  const wobbleOffset = Math.sin(newWobble) * 0.2;

  const newX = fish.x + newVx;
  const newY = Math.max(40, Math.min(height - 40, fish.y + newVy + wobbleOffset));

  const newFacingRight = newVx > 0.005 ? true : newVx < -0.005 ? false : fish.facingRight;

  if (newX < -fish.size - 100 || newX > width + fish.size + 100) {
    return createFish(fish.id, width, height);
  }

  if (dist < 150) {
    return {
      ...fish,
      x: newX,
      y: newY,
      vx: newVx,
      vy: newVy,
      wobble: newWobble,
      facingRight: newFacingRight,
      targetX: fish.facingRight ? width + fish.size + 300 : -fish.size - 300,
      targetY: 60 + Math.random() * (height - 120),
    };
  }

  return { ...fish, x: newX, y: newY, vx: newVx, vy: newVy, wobble: newWobble, facingRight: newFacingRight };
}

// ============================================================================
// Main Component
// ============================================================================

interface FishBackgroundProps {
  fishCount?: number;
}

const FishBackground: React.FC<FishBackgroundProps> = ({ fishCount = 20 }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const fishesRef = useRef<FishState[]>([]);
  const domRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dimensionsRef = useRef({ width: 0, height: 0 });
  const animationRef = useRef<number | undefined>(undefined);
  const initializedRef = useRef(false);

  // Initialize fish and start animation loop
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Capture initial dimensions
    dimensionsRef.current = {
      width: container.offsetWidth,
      height: container.offsetHeight,
    };

    // Initialize fish positions
    const { width, height } = dimensionsRef.current;
    fishesRef.current = Array.from({ length: fishCount }, (_, i) => {
      const fish = createFish(i, width, height);
      // Start fish spread across the screen, not all at the edges
      return {
        ...fish,
        x: Math.random() * width,
        y: 60 + Math.random() * (height - 120),
        targetX: fish.facingRight ? width + fish.size + 300 : -fish.size - 300,
      };
    });

    initializedRef.current = true;

    // Track container size with ResizeObserver
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        dimensionsRef.current = {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        };
      }
    });
    observer.observe(container);

    // Shared imperative positioner — one source of truth for fish layout, used
    // by both the animation loop and the static (reduced-motion) render.
    const positionFish = (el: HTMLDivElement, fish: FishState): void => {
      el.style.left = `${fish.x}px`;
      el.style.top = `${fish.y}px`;
      el.style.width = `${fish.size}px`;
      el.style.height = `${fish.size * 0.5}px`;
      el.style.transform = `scaleX(${fish.facingRight ? 1 : -1})`;
    };

    // Animation loop — updates DOM directly, bypassing React reconciliation
    const animate = () => {
      if (!initializedRef.current) return;
      const { width: w, height: h } = dimensionsRef.current;
      fishesRef.current = fishesRef.current.map(fish => stepFish(fish, w, h));
      fishesRef.current.forEach((fish, i) => {
        const el = domRefs.current[i];
        if (el) {
          positionFish(el, fish);
          const tailSpeed = 0.8 + Math.abs(fish.vx) * 3;
          (el.style as CSSStyleDeclaration & Record<string, string>)['--tail-speed'] = `${tailSpeed}s`;
        }
      });
      animationRef.current = requestAnimationFrame(animate);
    };

    // A11y (ORPHAN-MEDIUM-136): honor prefers-reduced-motion. When reduced motion
    // is requested we paint each fish ONCE (a calm static aquarium) and never start
    // the rAF loop. A change-listener re-evaluates the preference live.
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const paintStatic = (): void => {
      fishesRef.current.forEach((fish, i) => {
        const el = domRefs.current[i];
        if (el) positionFish(el, fish);
      });
    };
    const applyMotionPreference = (): void => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = undefined;
      }
      if (motionQuery.matches) {
        paintStatic();
      } else {
        animationRef.current = requestAnimationFrame(animate);
      }
    };

    applyMotionPreference();
    motionQuery.addEventListener('change', applyMotionPreference);

    return () => {
      initializedRef.current = false;
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      observer.disconnect();
      motionQuery.removeEventListener('change', applyMotionPreference);
    };
  }, [fishCount]);

  // Render fish divs — React only creates DOM structure once; positions are updated imperatively
  const fishElements = Array.from({ length: fishCount }, (_, i) => {
    // Use a stable fish type for initial render (will be updated imperatively)
    const fishType = i % FishComponents.length;
    const FishComponent = FishComponents[fishType];
    return (
      <div
        key={i}
        ref={el => { domRefs.current[i] = el; }}
        className="swimming-fish"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 80,
          height: 40,
          transition: 'transform 0.5s ease-out',
        }}
      >
        <FishComponent fishId={i} />
      </div>
    );
  });

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden pointer-events-none"
      style={{
        background: 'linear-gradient(to bottom, rgba(100,180,255,0.15) 0%, rgba(30,100,180,0.25) 50%, rgba(10,50,120,0.35) 100%)',
      }}
    >
      {/* Wave overlay */}
      <div className="absolute inset-0 wave-overlay" />

      {/* Sea floor — corals and seaweed */}
      <SeaFloor />

      {/* Fish — positioned imperatively via domRefs in the animation loop */}
      {fishElements}
    </div>
  );
};

export default FishBackground;
