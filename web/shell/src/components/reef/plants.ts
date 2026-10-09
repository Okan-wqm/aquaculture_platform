/**
 * Reef plants — kelp strands, eelgrass tufts and broadleaf weed, generated as
 * SVG markup for the login scene's plant layer.
 *
 * Geometry only: every colour is a class (`.kst-*`, `.klf-*`, `.kfloat`,
 * `.blade`, `.bl-*`) styled by reefScene.css, so the palette has one home.
 * The kelp is a chain of segments, each nested in the previous one's group,
 * so a sway on the base carries every segment above it.
 */

const SEGMENTS = 7;

export function kelpStrand(
  xPct: number,
  h: number,
  dur: number,
  uid: number,
  far: boolean,
): string {
  const segH = h / SEGMENTS;
  const defs = `<defs>
    <linearGradient id="kst-${uid}" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" class="kst-a"/><stop offset="100%" class="kst-b"/></linearGradient>
    <linearGradient id="klf-${uid}" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" class="klf-a"/><stop offset="100%" class="klf-b"/></linearGradient>
  </defs>`;
  let inner = `<circle class="kfloat" cx="45" cy="${h - SEGMENTS * segH + 3}" r="3"/>`;
  for (let i = SEGMENTS - 1; i >= 0; i -= 1) {
    const y0 = h - i * segH;
    const y1 = y0 - segH;
    const bend = i % 2 ? 3 : -3;
    const stipe = `<path d="M45 ${y0} C ${45 + bend} ${y0 - segH * 0.35} ${45 - bend * 0.7} ${y0 - segH * 0.7} 45 ${y1}" stroke="url(#kst-${uid})" stroke-width="${(3.4 - i * 0.32).toFixed(2)}" fill="none" stroke-linecap="round"/>`;
    const my = y0 - segH * 0.45;
    const s = i % 2 ? 1 : -1;
    const blade = `<path d="M45 ${my} q ${s * 10} -4 ${s * 21} -2 q ${s * 10} 2 ${s * 16} 9 q ${-s * 12} 3 ${-s * 24} -1 q ${-s * 8} -2.5 ${-s * 13} -6 Z" fill="url(#klf-${uid})" opacity="${(0.5 + i * 0.055).toFixed(2)}"/>
      <circle class="kfloat kfloat--small" cx="${45 + s * 4}" cy="${my - 1}" r="2"/>`;
    const blade2 =
      i < SEGMENTS - 1
        ? `<path d="M45 ${y0 - segH * 0.85} q ${-s * 8} -3.5 ${-s * 17} -1.5 q ${-s * 8} 2 ${-s * 13} 7 q ${s * 10} 2.5 ${s * 19} -0.5 q ${s * 7} -2 ${s * 11} -5 Z" fill="url(#klf-${uid})" opacity="${(0.42 + i * 0.05).toFixed(2)}"/>`
        : '';
    inner = `<g class="ks" style="transform-origin:45px ${y0}px;animation-delay:${((-i * dur) / 9).toFixed(2)}s;--ka:${(1.1 + i * 0.24).toFixed(2)}deg">${stipe}${blade}${blade2}${inner}</g>`;
  }
  const cls = far ? 'kelp-w kelp-far' : 'kelp-w';
  const opacity = far ? 1 : 0.92;
  return `<div class="${cls}" style="left:${xPct}%;height:${h}px;--kd:${dur}s;opacity:${opacity}"><svg viewBox="0 0 90 ${h}" class="fill-box">${defs}${inner}</svg></div>`;
}

export function grassTuft(xPct: number, h: number, n: number): string {
  let blades = '';
  for (let i = 0; i < n; i += 1) {
    const bx = 6 + (i * 58) / n + (((i * 7919) % 10) - 5) * 0.8;
    const lean = (((i * 104729) % 21) - 10) * 1.1;
    const bh = h * (0.6 + ((i * 31) % 10) / 22);
    const dur = (3.6 + ((i * 13) % 10) / 5).toFixed(2);
    const delay = (-((i * 17) % 10) / 2.2).toFixed(2);
    const alpha = (0.4 + ((i * 23) % 10) / 25).toFixed(2);
    const green = 88 + ((i * 11) % 30);
    const sway = (1.8 + ((i * 29) % 10) / 6).toFixed(2);
    blades += `<path class="gb blade" style="transform-origin:${bx}px ${h}px;animation-duration:${dur}s;animation-delay:${delay}s;--ka:${sway}deg;--g:${green};--a:${alpha}"
      d="M${bx} ${h} q ${lean * 0.4} ${-bh * 0.55} ${lean} ${-bh}"/>`;
  }
  return `<div class="grass-w" style="left:${xPct}%;height:${h + 6}px"><svg viewBox="0 0 70 ${h + 6}" class="fill-box">${blades}</svg></div>`;
}

export function broadleaf(xPct: number, h: number, uid: number): string {
  const leaf = (
    bx: number,
    lean: number,
    bh: number,
    dur: string,
    delay: string,
    op: number,
  ): string =>
    `<g class="gb" style="transform-origin:${bx}px ${h}px;animation-duration:${dur}s;animation-delay:${delay}s;--ka:1.6deg">
    <path d="M${bx} ${h} C ${bx + lean * 0.3} ${h - bh * 0.3} ${bx + lean - 7} ${h - bh * 0.62} ${bx + lean - 3} ${h - bh * 0.8}
             C ${bx + lean + 1} ${h - bh * 0.95} ${bx + lean + 5} ${h - bh * 0.9} ${bx + lean + 4} ${h - bh * 0.72}
             C ${bx + lean + 9} ${h - bh * 0.5} ${bx + 7} ${h - bh * 0.22} ${bx + 4} ${h} Z" fill="url(#bl-${uid})" opacity="${op}"/></g>`;
  return `<div class="grass-w" style="left:${xPct}%;height:${h + 6}px"><svg viewBox="0 0 90 ${h + 6}" class="fill-box">
    <defs><linearGradient id="bl-${uid}" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" class="bl-a"/><stop offset="100%" class="bl-b"/></linearGradient></defs>
    ${leaf(30, 14, h * 0.92, '6.5', '0', 0.85)}${leaf(44, -12, h * 0.78, '7.4', '-2.1', 0.7)}${leaf(56, 9, h * 0.6, '5.8', '-3.4', 0.6)}
  </svg></div>`;
}

/** The full plant layer: kelp at the edges, two blurred far strands, grass and broadleaf between. */
export function plantLayer(): string {
  let uid = 0;
  const next = (): number => {
    uid += 1;
    return uid;
  };
  const near: ReadonlyArray<readonly [number, number, number]> = [
    [1.5, 380, 7.5],
    [6, 300, 8.5],
    [11.5, 420, 6.8],
    [83, 340, 8],
    [90, 430, 7.2],
    [95.5, 310, 6.4],
  ];
  const far: ReadonlyArray<readonly [number, number, number]> = [
    [17, 250, 9],
    [77, 280, 8.2],
  ];
  const tufts: ReadonlyArray<readonly [number, number, number]> = [
    [15, 96, 12],
    [27, 74, 10],
    [44, 60, 9],
    [58, 68, 10],
    [70, 88, 12],
    [80, 70, 9],
  ];
  return [
    ...near.map(([x, h, d]) => kelpStrand(x, h, d, next(), false)),
    ...far.map(([x, h, d]) => kelpStrand(x, h, d, next(), true)),
    ...tufts.map(([x, h, n]) => grassTuft(x, h, n)),
    broadleaf(22, 110, next()),
    broadleaf(63, 96, next()),
  ].join('');
}
