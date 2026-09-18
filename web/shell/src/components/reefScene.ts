/**
 * Suderra industrial reef — high-fidelity underwater scene for the auth surface.
 *
 * WHAT: a self-contained custom element (`<suderra-reef-scene>`, shadow DOM)
 * rendering realistic aquaculture species (salmon, sea bass, gilt-head bream,
 * baitfish school, trout, mackerel, turbot, tuna) with burst-and-coast
 * swimming, tail-beat undulation, pitch banking and depth-of-field planes;
 * chained-segment kelp/eelgrass sway; god rays, marine snow, caustic dapple,
 * vent bubbles.
 *
 * WHY a custom element instead of React state: the scene mutates ~20 fish
 * transforms per frame via requestAnimationFrame; keeping it outside React
 * avoids 60fps reconciliation (same rationale as the FishBackground it
 * replaced). Ported 1:1 from the approved SUDERRA login design mock.
 *
 * Attributes: density="low|med|high" (fish roster size), plants="false" hides
 * the plant layer. Honors prefers-reduced-motion (paints one static frame).
 */

// ── Species artwork (facing RIGHT; .pitchg = whole-body pitch, .tailg = caudal, .pectg = pectoral) ──
const salmonArt = (id: number): string => {
  const spots = ([[78, 23, 1.3], [92, 19, 1.1], [107, 24, 1.4], [121, 19.5, 1.1], [136, 25, 1.3], [150, 21, 1], [114, 30, 1], [85, 29, 0.9]] as Array<[number, number, number]>)
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="rgba(8,18,26,0.5)"/>`).join('');
  return `<svg viewBox="0 0 200 72" style="width:100%;height:100%;overflow:visible">
    <defs>
      <linearGradient id="sb-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#142C3B"/><stop offset="34%" stop-color="#2C4C5D"/><stop offset="58%" stop-color="#6E8C9C"/><stop offset="78%" stop-color="#AFC4CE"/><stop offset="92%" stop-color="#C8D8DF"/><stop offset="100%" stop-color="#9FB4BE"/>
      </linearGradient>
      <linearGradient id="st-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#16303F"/><stop offset="100%" stop-color="#3E5D6F"/></linearGradient>
    </defs>
    <g class="pitchg" style="transform-origin:110px 36px">
      <g class="tailg" style="transform-origin:46px 36px">
        <path d="M46 29 C36 22 26 16.5 15 14 C19.5 22 21 29 20.5 36 C21 43 19.5 50 15 58 C26 55.5 36 50 46 43 Z" fill="url(#st-${id})"/>
        <path d="M43 33 C33 27 26 22 18 18" stroke="rgba(210,230,238,0.12)" stroke-width="0.8" fill="none"/>
        <path d="M43 39 C33 45 26 50 18 54" stroke="rgba(210,230,238,0.12)" stroke-width="0.8" fill="none"/>
      </g>
      <path d="M139 57.5 C133 62.5 124 63.5 118 61 C124 58.5 131 56.5 135 55.5 Z" fill="rgba(70,95,110,0.6)"/>
      <path d="M112 55.5 C108 60 101 62 97 61 C101 57.5 106 55.5 109 54.5 Z" fill="rgba(70,95,110,0.55)"/>
      <path d="M195 36 C188 27 176 21 158 17 C132 11 98 11 71 19 C58 23 48 29 43 34 L43 38 C48 43 58 49 71 53 C98 61 132 61 158 55 C176 51 188 45 195 36 Z" fill="url(#sb-${id})"/>
      <path d="M122 14.5 C115 7.5 101 6 92 9 C97 13.5 108 16 118 16.5 Z" fill="rgba(23,44,58,0.9)"/>
      <path d="M146 17.5 C150 14.5 155 14.5 157 16.5 C154 18.5 149 19 146 17.5 Z" fill="rgba(23,44,58,0.65)"/>
      ${spots}
      <path d="M70 18 C100 11 138 11 164 18" stroke="rgba(200,240,238,0.1)" stroke-width="1.2" fill="none" stroke-linecap="round"/>
      <path d="M75 52 C102 59 132 59 156 54" stroke="rgba(220,240,245,0.14)" stroke-width="1" fill="none"/>
      <path d="M55 36.5 C95 33.5 140 33.5 176 35" stroke="rgba(190,215,225,0.16)" stroke-width="0.8" fill="none"/>
      <path d="M162 21 C154 27 153 44 161 51" stroke="rgba(6,20,30,0.45)" stroke-width="1.4" fill="none"/>
      <path d="M168 23 C162 28 161 43 167 48" stroke="rgba(6,20,30,0.25)" stroke-width="1" fill="none"/>
      <path d="M195 36 C190 38 185 39.5 181 39.5" stroke="rgba(6,16,24,0.55)" stroke-width="1.1" fill="none"/>
      <g class="pectg" style="transform-origin:150px 45px">
        <path d="M150 44 C143 50 134 55 126 57 C133 58.5 143 56 151 49 Z" fill="rgba(130,160,175,0.55)" stroke="rgba(200,230,240,0.15)" stroke-width="0.5"/>
      </g>
      <circle cx="178.5" cy="29.5" r="3.9" fill="none" stroke="rgba(200,240,238,0.28)" stroke-width="0.8"/>
      <circle cx="178.5" cy="29.5" r="3.2" fill="#0A151D"/>
      <circle cx="179.6" cy="28.4" r="1" fill="rgba(230,245,248,0.85)"/>
    </g></svg>`;
};

const bassArt = (id: number): string => (
  `<svg viewBox="0 0 190 62" style="width:100%;height:100%;overflow:visible">
    <defs>
      <linearGradient id="bb-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#1E3547"/><stop offset="40%" stop-color="#4E6A7B"/><stop offset="66%" stop-color="#9AB1BD"/><stop offset="85%" stop-color="#CFDDE3"/><stop offset="100%" stop-color="#A8BCC6"/>
      </linearGradient>
      <linearGradient id="bt-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2A4658"/><stop offset="100%" stop-color="#4E6B7C"/></linearGradient>
    </defs>
    <g class="pitchg" style="transform-origin:105px 31px">
      <g class="tailg" style="transform-origin:45px 31px">
        <path d="M45 25.5 C35 20 26 17 15 16.5 C19 23 20.5 27.5 20.5 31 C20.5 34.5 19 39 15 45.5 C26 45 35 42 45 36.5 Z" fill="url(#bt-${id})"/>
        <path d="M42 28 C33 24 27 21.5 19 20" stroke="rgba(210,230,238,0.1)" stroke-width="0.7" fill="none"/>
        <path d="M42 34 C33 38 27 40.5 19 42" stroke="rgba(210,230,238,0.1)" stroke-width="0.7" fill="none"/>
      </g>
      <path d="M136 47.5 C130 52 122 53 116 51 C122 48.5 129 47 133 46 Z" fill="rgba(60,85,100,0.55)"/>
      <path d="M108 46.5 C104 51 98 52.5 94 51.5 C98 48.5 102 46.5 105 45.5 Z" fill="rgba(60,85,100,0.5)"/>
      <path d="M186 31 C180 24 169 19 152 16 C127 11 95 11 69 18 C57 21.5 47 27 42 30 L42 32 C47 35 57 40.5 69 44 C95 51 127 51 152 46 C169 43 180 38 186 31 Z" fill="url(#bb-${id})"/>
      <path d="M86 13.5 L90 6 L94 12.5 L99 5.5 L103 12 L108 6 L111 12 L115 7.5 L117 13 C107 15 96 15.5 86 15.5 Z" fill="rgba(26,45,58,0.85)"/>
      <path d="M122 13 C130 9 141 9 147 12 C141 15 130 16 123 15.5 Z" fill="rgba(26,45,58,0.72)"/>
      <path d="M68 17 C98 11 134 11 160 17.5" stroke="rgba(200,240,238,0.09)" stroke-width="1.1" fill="none" stroke-linecap="round"/>
      <path d="M52 31 C92 29 138 29 172 30.5" stroke="rgba(190,215,225,0.2)" stroke-width="0.9" fill="none"/>
      <path d="M70 24 C100 20.5 140 20.5 164 24" stroke="rgba(210,230,240,0.07)" stroke-width="2.4" fill="none"/>
      <path d="M72 38 C102 41.5 138 41.5 162 38" stroke="rgba(210,230,240,0.05)" stroke-width="2.4" fill="none"/>
      <ellipse cx="156" cy="24" rx="3" ry="4" fill="rgba(8,18,26,0.35)"/>
      <path d="M158 20.5 C151 26 150 37 157 43.5" stroke="rgba(8,22,32,0.45)" stroke-width="1.3" fill="none"/>
      <path d="M160 21 C154 26 153 36 159 42" stroke="rgba(200,240,238,0.14)" stroke-width="0.8" fill="none"/>
      <path d="M186 31 C181 33 176.5 34 172.5 34" stroke="rgba(6,16,24,0.6)" stroke-width="1.1" fill="none"/>
      <g class="pectg" style="transform-origin:148px 38px">
        <path d="M148 37 C141 43 132 47 124 48.5 C131 50 141 48 149 42 Z" fill="rgba(140,168,182,0.5)" stroke="rgba(200,230,240,0.14)" stroke-width="0.5"/>
      </g>
      <circle cx="173.5" cy="26" r="3.7" fill="none" stroke="rgba(200,240,238,0.26)" stroke-width="0.8"/>
      <circle cx="173.5" cy="26" r="3" fill="#0A151D"/>
      <circle cx="174.5" cy="25" r="0.9" fill="rgba(230,245,248,0.85)"/>
    </g></svg>`
);

const breamArt = (id: number): string => (
  `<svg viewBox="0 0 152 94" style="width:100%;height:100%;overflow:visible">
    <defs>
      <linearGradient id="gb-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#24394A"/><stop offset="42%" stop-color="#5E7889"/><stop offset="68%" stop-color="#A7BAC5"/><stop offset="88%" stop-color="#D6E2E7"/><stop offset="100%" stop-color="#B0C2CB"/>
      </linearGradient>
      <linearGradient id="gt-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22394A"/><stop offset="100%" stop-color="#48657A"/></linearGradient>
    </defs>
    <g class="pitchg" style="transform-origin:88px 49px">
      <g class="tailg" style="transform-origin:40px 49px">
        <path d="M40 41 C31 34 23 30 13 28.5 C17.5 36 19 43 18.5 49 C19 55.5 17.5 62 13 69.5 C23 68 31 64 40 57 Z" fill="url(#gt-${id})"/>
        <path d="M37 44 C29 39 24 35.5 17 33" stroke="rgba(210,230,238,0.1)" stroke-width="0.7" fill="none"/>
        <path d="M37 54 C29 59 24 62.5 17 65" stroke="rgba(210,230,238,0.1)" stroke-width="0.7" fill="none"/>
      </g>
      <path d="M114 82 C107 87 98 87.5 92 84.5 C99 82 107 80.5 111 79.5 Z" fill="rgba(60,85,100,0.55)"/>
      <path d="M89 79 C86 84 80 86.5 76 85.5 C80 82 84 79.5 87 78.5 Z" fill="rgba(60,85,100,0.5)"/>
      <path d="M146 50 C143 39 136 28 122 20 C106 11 84 10 66 17 C51 23 40 34 36 45 L36 53 C40 64 51 74 66 80 C84 87 106 86 122 77 C136 70 143 60 146 50 Z" fill="url(#gb-${id})"/>
      <path d="M64 18 L68 8.5 L72 15 L77 8 L81 14.5 L86 8 L90 14.5 L95 8.5 L98 14.5 C106 12.5 114 13 120 16.5 L118 19 C100 13.5 80 14 64 18 Z" fill="rgba(28,48,62,0.85)"/>
      <path d="M64 17 C88 11 112 12 128 22" stroke="rgba(200,240,238,0.09)" stroke-width="1.1" fill="none" stroke-linecap="round"/>
      <path d="M48 42 C80 38 112 39 132 44" stroke="rgba(190,215,225,0.16)" stroke-width="0.8" fill="none"/>
      <path d="M126 27 C118 34 116 62 125 70" stroke="rgba(8,22,32,0.4)" stroke-width="1.4" fill="none"/>
      <ellipse cx="118" cy="31" rx="3.6" ry="4.6" fill="rgba(10,20,28,0.4)"/>
      <path d="M137 30 C135 34 134.5 38 135.5 42" stroke="rgba(212,178,96,0.55)" stroke-width="3.4" fill="none" stroke-linecap="round"/>
      <path d="M137 30 C135 34 134.5 38 135.5 42" stroke="rgba(255,224,150,0.2)" stroke-width="5.5" fill="none" stroke-linecap="round"/>
      <path d="M146 50 C142 52 138 53 134.5 53" stroke="rgba(6,16,24,0.55)" stroke-width="1.1" fill="none"/>
      <g class="pectg" style="transform-origin:118px 58px">
        <path d="M118 57 C111 63 102 67.5 94 69 C101 70.5 111 68.5 119 62 Z" fill="rgba(140,168,182,0.5)" stroke="rgba(200,230,240,0.14)" stroke-width="0.5"/>
      </g>
      <circle cx="129" cy="41" r="4" fill="none" stroke="rgba(200,240,238,0.26)" stroke-width="0.8"/>
      <circle cx="129" cy="41" r="3.3" fill="#0A151D"/>
      <circle cx="130.2" cy="39.8" r="1" fill="rgba(230,245,248,0.85)"/>
    </g></svg>`
);

const baitArt = (id: number): string => (
  `<svg viewBox="0 0 64 18" style="width:100%;height:100%;overflow:visible">
    <defs><linearGradient id="bf-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2A4254"/><stop offset="55%" stop-color="#7E97A6"/><stop offset="100%" stop-color="#C4D4DB"/>
    </linearGradient></defs>
    <g class="pitchg" style="transform-origin:32px 9px">
      <g class="tailg baittail" style="transform-origin:9px 9px">
        <path d="M9 9 L2 4 C3.6 7 3.6 11 2 14 Z" fill="rgba(70,95,110,0.7)"/>
      </g>
      <path d="M60 9 C54 4.5 45 3 35 3.8 C23 4.8 11 7 4 9 C11 11 23 13.2 35 14.2 C45 15 54 13.5 60 9 Z" fill="url(#bf-${id})"/>
      <path d="M10 9 L54 8.4" stroke="rgba(215,235,242,0.35)" stroke-width="1.2"/>
      <path d="M14 5.6 C30 3.4 46 3.8 56 6" stroke="rgba(200,240,238,0.3)" stroke-width="0.7" fill="none"/>
      <circle cx="52.5" cy="8" r="1.3" fill="#0A151D"/><circle cx="53" cy="7.6" r="0.4" fill="rgba(230,245,248,0.9)"/>
    </g></svg>`
);

const troutArt = (id: number): string => {
  const spots = ([[76, 22, 1.2], [88, 18, 1], [100, 23, 1.3], [112, 18.5, 1], [124, 24, 1.2], [136, 20, 1], [148, 24, 1.1], [92, 28, 0.9], [116, 29, 0.9], [140, 29, 0.8], [70, 27, 0.9], [104, 14.5, 0.9], [130, 15, 0.8], [155, 20, 0.9]] as Array<[number, number, number]>)
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="rgba(18,30,24,0.55)"/>`).join('');
  return `<svg viewBox="0 0 190 64" style="width:100%;height:100%;overflow:visible">
    <defs>
      <linearGradient id="tr-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#27412F"/><stop offset="34%" stop-color="#567560"/><stop offset="56%" stop-color="#9FB2A2"/><stop offset="74%" stop-color="#CBD8CC"/><stop offset="90%" stop-color="#D8E2D8"/><stop offset="100%" stop-color="#B4C4B8"/>
      </linearGradient>
      <linearGradient id="trt-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2A4536"/><stop offset="100%" stop-color="#5C7A64"/></linearGradient>
    </defs>
    <g class="pitchg" style="transform-origin:105px 32px">
      <g class="tailg" style="transform-origin:46px 32px">
        <path d="M46 25.5 C36 19 26 14.5 15 12.5 C19.5 20 21 26 20.5 32 C21 38 19.5 44 15 51.5 C26 49.5 36 45 46 38.5 Z" fill="url(#trt-${id})"/>
        <circle cx="28" cy="24" r="1" fill="rgba(18,30,24,0.5)"/><circle cx="24" cy="32" r="0.9" fill="rgba(18,30,24,0.5)"/><circle cx="28" cy="40" r="1" fill="rgba(18,30,24,0.5)"/>
      </g>
      <path d="M137 49.5 C131 54.5 122 55.5 116 53 C122 50.5 129 48.5 133 47.5 Z" fill="rgba(190,140,120,0.5)"/>
      <path d="M110 47.5 C106 52 99 54 95 53 C99 49.5 104 47.5 107 46.5 Z" fill="rgba(190,140,120,0.45)"/>
      <path d="M186 32 C180 24 169 18.5 152 15.5 C127 10.5 96 10.5 70 18 C57 21.5 47 27 42 30.5 L42 33.5 C47 37 57 42.5 70 46 C96 53.5 127 53.5 152 48.5 C169 45.5 180 40 186 32 Z" fill="url(#tr-${id})"/>
      <path d="M50 32 C90 29.5 140 29.5 176 31.5" stroke="rgba(217,130,130,0.38)" stroke-width="7" fill="none" stroke-linecap="round"/>
      <path d="M54 32 C92 30 138 30 172 31.5" stroke="rgba(226,152,152,0.25)" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <path d="M121 13 C114 6.5 101 5.5 92 8.5 C97 13 108 15.5 117 16 Z" fill="rgba(34,52,42,0.9)"/>
      <circle cx="104" cy="10.5" r="0.9" fill="rgba(10,18,14,0.6)"/><circle cx="112" cy="10" r="0.8" fill="rgba(10,18,14,0.6)"/>
      <path d="M146 16.5 C150 13.5 155 13.5 157 15.5 C154 17.5 149 18 146 16.5 Z" fill="rgba(34,52,42,0.7)"/>
      ${spots}
      <path d="M70 17 C100 10 138 10 164 17" stroke="rgba(200,240,238,0.09)" stroke-width="1.1" fill="none" stroke-linecap="round"/>
      <path d="M162 20 C154 26 153 40 161 46.5" stroke="rgba(10,22,16,0.45)" stroke-width="1.4" fill="none"/>
      <path d="M186 32 C181 34 176.5 35 172.5 35" stroke="rgba(6,16,12,0.55)" stroke-width="1.1" fill="none"/>
      <g class="pectg" style="transform-origin:150px 41px">
        <path d="M150 40 C143 46 134 50.5 126 52.5 C133 54 143 51.5 151 45 Z" fill="rgba(196,150,128,0.5)" stroke="rgba(230,200,180,0.15)" stroke-width="0.5"/>
      </g>
      <circle cx="175.5" cy="26" r="3.8" fill="none" stroke="rgba(200,240,238,0.28)" stroke-width="0.8"/>
      <circle cx="175.5" cy="26" r="3.1" fill="#0A1510"/>
      <circle cx="176.6" cy="24.9" r="1" fill="rgba(230,245,248,0.85)"/>
    </g></svg>`;
};

const mackerelArt = (id: number): string => {
  const stripes = ([[64, 9, 9.5], [78, 8, 11], [92, 7.5, 11], [106, 7, 11.5], [120, 7, 11.5], [134, 7.5, 10]] as Array<[number, number, number]>)
    .map(([x, y, l]) => `<path d="M${x} ${y} q 3 ${l * 0.5} -1 ${l}" stroke="rgba(10,26,34,0.5)" stroke-width="2" fill="none" stroke-linecap="round"/>`).join('');
  const finlets = [54, 62, 70, 78].map((x) => `<path d="M${x} 11.5 l-3.5 -3 l0.5 3.4 Z" fill="rgba(30,70,74,0.6)"/><path d="M${x} 30.5 l-3.5 3 l0.5 -3.4 Z" fill="rgba(30,70,74,0.6)"/>`).join('');
  return `<svg viewBox="0 0 176 42" style="width:100%;height:100%;overflow:visible">
    <defs>
      <linearGradient id="mk-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#14424A"/><stop offset="30%" stop-color="#1E5A60"/><stop offset="48%" stop-color="#4E8A8C"/><stop offset="62%" stop-color="#9EB8B8"/><stop offset="80%" stop-color="#D2E0DE"/><stop offset="100%" stop-color="#B0C4C2"/>
      </linearGradient>
      <linearGradient id="mkt-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#16444C"/><stop offset="100%" stop-color="#417276"/></linearGradient>
    </defs>
    <g class="pitchg" style="transform-origin:100px 21px">
      <g class="tailg" style="transform-origin:50px 21px">
        <path d="M50 17.5 C40 13 30 9 20 7.5 C26 12.5 28.5 17 28.5 21 C28.5 25 26 29.5 20 34.5 C30 33 40 29 50 24.5 Z" fill="url(#mkt-${id})"/>
      </g>
      <path d="M172 21 C167 15.5 157 11.5 143 9.5 C120 6 92 6.5 70 12 C59 14.5 50 18 46 20 L46 22 C50 24 59 27.5 70 30 C92 35.5 120 36 143 32.5 C157 30.5 167 26.5 172 21 Z" fill="url(#mk-${id})"/>
      ${stripes}${finlets}
      <path d="M96 9 L100 3.5 L103 8.5 L107 4 L110 8.5 C105 10 100 10.5 96 10.5 Z" fill="rgba(16,42,48,0.85)"/>
      <path d="M118 8 C124 5 132 5 137 7.5 C132 10 124 11 119 10.5 Z" fill="rgba(16,42,48,0.75)"/>
      <path d="M118 33.5 C124 36.5 131 36.5 136 34.5 C131 32.5 124 31.5 120 31.5 Z" fill="rgba(40,72,76,0.55)"/>
      <path d="M68 11.5 C96 6.5 128 6.5 150 12" stroke="rgba(200,240,238,0.09)" stroke-width="1" fill="none" stroke-linecap="round"/>
      <path d="M56 21 C96 19.5 132 19.5 160 20.5" stroke="rgba(190,215,225,0.14)" stroke-width="0.7" fill="none"/>
      <path d="M146 12 C140 16.5 139.5 26 145 30" stroke="rgba(8,24,30,0.45)" stroke-width="1.2" fill="none"/>
      <path d="M172 21 C168 22.5 164.5 23.5 161 23.5" stroke="rgba(6,16,20,0.55)" stroke-width="1" fill="none"/>
      <g class="pectg" style="transform-origin:138px 26px">
        <path d="M138 25 C132 29.5 125 33 118 34.5 C124 36 132 33.5 139 28.5 Z" fill="rgba(120,150,152,0.5)"/>
      </g>
      <circle cx="158" cy="17.5" r="3.4" fill="none" stroke="rgba(200,240,238,0.26)" stroke-width="0.7"/>
      <circle cx="158" cy="17.5" r="2.8" fill="#0A151D"/>
      <circle cx="159" cy="16.6" r="0.8" fill="rgba(230,245,248,0.85)"/>
    </g></svg>`;
};

const turbotArt = (id: number): string => {
  const mottle = ([[60, 40, 4], [84, 30, 3.4], [104, 46, 4.4], [76, 62, 3.8], [52, 58, 3], [96, 70, 3.2], [116, 58, 2.8], [68, 24, 2.6], [44, 44, 2.4], [88, 50, 2.2]] as Array<[number, number, number]>)
    .map(([x, y, r]) => `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${(r * 0.75).toFixed(1)}" fill="rgba(38,48,38,0.45)"/>`).join('');
  const speckle = ([[70, 36, 1.4], [92, 42, 1.2], [58, 50, 1.3], [108, 36, 1.1], [80, 74, 1.2], [100, 60, 1], [48, 34, 1], [120, 48, 1.1]] as Array<[number, number, number]>)
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="rgba(184,194,172,0.3)"/>`).join('');
  const D = 'M148 52 C144 34 126 18 100 12 C72 5.5 44 12 28 30 C18 41 14 52 16 62 C20 78 40 92 68 96 C98 100.5 126 92 140 74 C146 66 149 59 148 52 Z';
  return `<svg viewBox="0 0 156 104" style="width:100%;height:100%;overflow:visible">
    <defs>
      <linearGradient id="tb-${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#4E5C48"/><stop offset="45%" stop-color="#6E7C64"/><stop offset="100%" stop-color="#55634F"/>
      </linearGradient>
      <linearGradient id="tbt-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#485646"/><stop offset="100%" stop-color="#5C6A56"/></linearGradient>
    </defs>
    <g class="pitchg" style="transform-origin:82px 54px">
      <g class="tailg" style="transform-origin:26px 54px">
        <path d="M26 42 C17 38 9 38 4 42 C8 48 8 58 4 64 C9 68 17 68 26 62 Z" fill="url(#tbt-${id})"/>
        <path d="M22 45 C14 43 10 43 7 45 M22 59 C14 61 10 61 7 59" stroke="rgba(200,215,195,0.12)" stroke-width="0.8" fill="none"/>
      </g>
      <path d="${D}" stroke="rgba(104,120,100,0.5)" stroke-width="9" fill="none"/>
      <path d="${D}" stroke="rgba(56,70,56,0.5)" stroke-width="8" stroke-dasharray="2.2 3.4" fill="none"/>
      <path d="${D}" fill="url(#tb-${id})"/>
      ${mottle}${speckle}
      <path d="M34 28 C60 10 96 6 128 20" stroke="rgba(200,240,238,0.08)" stroke-width="1.1" fill="none" stroke-linecap="round"/>
      <path d="M120 44 C114 50 114 62 121 68" stroke="rgba(24,32,24,0.5)" stroke-width="1.3" fill="none"/>
      <path d="M147 50 C143 53 139 54.5 135 54.5" stroke="rgba(16,22,16,0.55)" stroke-width="1.1" fill="none"/>
      <circle cx="118" cy="30" r="4" fill="none" stroke="rgba(200,240,238,0.24)" stroke-width="0.8"/>
      <circle cx="118" cy="30" r="3.3" fill="#101710"/><circle cx="119.2" cy="28.9" r="1" fill="rgba(230,245,248,0.8)"/>
      <circle cx="128" cy="38" r="3.7" fill="none" stroke="rgba(200,240,238,0.24)" stroke-width="0.8"/>
      <circle cx="128" cy="38" r="3" fill="#101710"/><circle cx="129" cy="37" r="0.9" fill="rgba(230,245,248,0.8)"/>
    </g></svg>`;
};

const tunaArt = (id: number): string => {
  const finTop = ([[142, 11.5], [128, 12.5], [114, 14.5], [100, 18], [86, 22.5], [74, 27.5]] as Array<[number, number]>).map(([x, y]) => `<path d="M${x} ${y} l-5 -4 l1 4.6 Z" fill="rgba(226,196,90,0.7)"/>`).join('');
  const finBot = ([[142, 74.5], [128, 73.5], [114, 71.5], [100, 68], [86, 63.5], [74, 58.5]] as Array<[number, number]>).map(([x, y]) => `<path d="M${x} ${y} l-5 4 l1 -4.6 Z" fill="rgba(226,196,90,0.7)"/>`).join('');
  return `<svg viewBox="0 0 250 86" style="width:100%;height:100%;overflow:visible">
    <defs>
      <linearGradient id="tn-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0F2B46"/><stop offset="34%" stop-color="#2E5578"/><stop offset="56%" stop-color="#7E9CB2"/><stop offset="76%" stop-color="#C3D2DC"/><stop offset="92%" stop-color="#DCE6EC"/><stop offset="100%" stop-color="#B4C4CE"/>
      </linearGradient>
      <linearGradient id="tnt-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#17395C"/><stop offset="100%" stop-color="#3E6486"/></linearGradient>
    </defs>
    <g class="pitchg" style="transform-origin:140px 43px">
      <g class="tailg" style="transform-origin:58px 43px">
        <path d="M58 36 C44 27 30 18 14 10 C25 22 30 33 30 43 C30 53 25 64 14 76 C30 68 44 59 58 50 Z" fill="url(#tnt-${id})"/>
        <path d="M52 39 C40 32 30 25 20 18 M52 47 C40 54 30 61 20 68" stroke="rgba(210,230,238,0.12)" stroke-width="1" fill="none"/>
      </g>
      <path d="M58 40 l7 3 l-7 3 Z" fill="rgba(20,44,66,0.7)"/>
      <path d="M244 43 C238 32 224 24 204 19 C172 11 130 11 96 20 C78 25 64 32 56 40 L56 46 C64 54 78 61 96 66 C130 75 172 75 204 67 C224 62 238 54 244 43 Z" fill="url(#tn-${id})"/>
      <path d="M144 18 C138 11 128 9.5 120 12 C127 15.5 135 17.5 144 18 Z" fill="rgba(16,42,66,0.9)"/>
      <path d="M184 17 C178 5 166 2.5 158 6 C166 11.5 175 15.5 184 17 Z" fill="rgba(20,50,78,0.9)"/>
      <path d="M196 67.5 C190 79.5 178 83 170 79 C178 73.5 187 69.5 196 67.5 Z" fill="rgba(60,88,110,0.7)"/>
      ${finTop}${finBot}
      <path d="M94 19 C132 11 178 11 208 19" stroke="rgba(200,240,238,0.11)" stroke-width="1.2" fill="none" stroke-linecap="round"/>
      <path d="M100 64 C136 71 176 71 202 65" stroke="rgba(220,240,245,0.16)" stroke-width="1.1" fill="none"/>
      <path d="M70 43 C130 40 180 40 226 42" stroke="rgba(190,215,225,0.14)" stroke-width="0.9" fill="none"/>
      <path d="M206 25 C198 32 197 55 205 62" stroke="rgba(8,22,36,0.5)" stroke-width="1.6" fill="none"/>
      <path d="M212 24 C206 30 205 52 211 59" stroke="rgba(8,22,36,0.25)" stroke-width="1" fill="none"/>
      <path d="M244 43 C238 45.5 232 47 227 47" stroke="rgba(6,16,24,0.6)" stroke-width="1.2" fill="none"/>
      <g class="pectg" style="transform-origin:196px 50px">
        <path d="M196 49 C186 57 172 63 158 65 C170 68 186 64 198 55 Z" fill="rgba(70,100,125,0.6)" stroke="rgba(200,230,240,0.14)" stroke-width="0.5"/>
      </g>
      <circle cx="222" cy="36" r="4.8" fill="none" stroke="rgba(200,240,238,0.3)" stroke-width="0.9"/>
      <circle cx="222" cy="36" r="4" fill="#0A151D"/>
      <circle cx="223.4" cy="34.6" r="1.2" fill="rgba(230,245,248,0.85)"/>
    </g></svg>`;
};

// ── Species config ─────────────────────────────────────────────────────────
type SpeciesKey = 'salmon' | 'bass' | 'bream' | 'trout' | 'mackerel' | 'turbot' | 'tuna';
type PlaneKey = 'far' | 'mid' | 'near';

interface SpeciesSpec {
  art: (id: number) => string;
  ar: number;
  baseW: number;
  vmax: number;
  turn: number;
  amp: number;
  tailK: number;
  band: 'open' | 'upper' | 'bottom';
  burst: [number, number];
  coast: [number, number];
  coastFrac: number;
  bob: number;
  pitchMax: number;
  exitBias?: number;
}

const SPECIES: Record<SpeciesKey, SpeciesSpec> = {
  salmon:   { art: salmonArt,   ar: 72 / 200,  baseW: 200, vmax: 85,  turn: 1.3, amp: 9,   tailK: 2.4, band: 'open',   burst: [0.5, 1.2], coast: [1.4, 3.4], coastFrac: 0.24, bob: 6,  pitchMax: 12 },
  bass:     { art: bassArt,     ar: 62 / 190,  baseW: 176, vmax: 72,  turn: 1.9, amp: 10,  tailK: 2.6, band: 'open',   burst: [0.4, 0.9], coast: [0.9, 2.2], coastFrac: 0.3,  bob: 6,  pitchMax: 12 },
  bream:    { art: breamArt,    ar: 94 / 152,  baseW: 126, vmax: 46,  turn: 1.7, amp: 7,   tailK: 2.0, band: 'open',   burst: [0.4, 0.8], coast: [2.2, 4.5], coastFrac: 0.12, bob: 10, pitchMax: 10 },
  trout:    { art: troutArt,    ar: 64 / 190,  baseW: 186, vmax: 92,  turn: 1.5, amp: 9,   tailK: 2.5, band: 'open',   burst: [0.5, 1.1], coast: [1.2, 3.0], coastFrac: 0.26, bob: 6,  pitchMax: 12 },
  mackerel: { art: mackerelArt, ar: 42 / 176,  baseW: 168, vmax: 108, turn: 1.6, amp: 6,   tailK: 3.2, band: 'upper',  burst: [1.2, 2.4], coast: [0.8, 1.6], coastFrac: 0.5,  bob: 4,  pitchMax: 8 },
  turbot:   { art: turbotArt,   ar: 104 / 156, baseW: 118, vmax: 30,  turn: 1.2, amp: 4.5, tailK: 1.2, band: 'bottom', burst: [0.6, 1.1], coast: [2.5, 5.5], coastFrac: 0.06, bob: 3,  pitchMax: 4 },
  tuna:     { art: tunaArt,     ar: 86 / 250,  baseW: 250, vmax: 210, turn: 0.9, amp: 5,   tailK: 3.4, band: 'open',   burst: [1.6, 3.0], coast: [0.9, 1.8], coastFrac: 0.55, bob: 3,  pitchMax: 7, exitBias: 0.7 },
};
const PLANES: Record<PlaneKey, { z: number }> = { far: { z: 0.5 }, mid: { z: 0.74 }, near: { z: 1 } };

// ── Plants ──────────────────────────────────────────────────────────────────
const kelpStrand = (xPct: number, h: number, dur: number, uid: number, opacity: number): string => {
  const N = 7, segH = h / N;
  const defs = `<defs>
    <linearGradient id="kst-${uid}" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="rgba(24,60,50,0.95)"/><stop offset="100%" stop-color="rgba(62,138,116,0.75)"/></linearGradient>
    <linearGradient id="klf-${uid}" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="rgba(30,74,60,0.85)"/><stop offset="100%" stop-color="rgba(70,150,124,0.6)"/></linearGradient>
  </defs>`;
  let inner = `<circle cx="45" cy="${h - N * segH + 3}" r="3" fill="rgba(110,231,199,0.16)" stroke="rgba(110,231,199,0.3)" stroke-width="0.7"/>`;
  for (let i = N - 1; i >= 0; i--) {
    const y0 = h - i * segH, y1 = y0 - segH;
    const bend = i % 2 ? 3 : -3;
    const stipe = `<path d="M45 ${y0} C ${45 + bend} ${y0 - segH * 0.35} ${45 - bend * 0.7} ${y0 - segH * 0.7} 45 ${y1}" stroke="url(#kst-${uid})" stroke-width="${(3.4 - i * 0.32).toFixed(2)}" fill="none" stroke-linecap="round"/>`;
    const my = y0 - segH * 0.45;
    const s = i % 2 ? 1 : -1;
    const blade = `<path d="M45 ${my} q ${s * 10} -4 ${s * 21} -2 q ${s * 10} 2 ${s * 16} 9 q ${-s * 12} 3 ${-s * 24} -1 q ${-s * 8} -2.5 ${-s * 13} -6 Z" fill="url(#klf-${uid})" opacity="${(0.5 + i * 0.055).toFixed(2)}"/>
      <circle cx="${45 + s * 4}" cy="${my - 1}" r="2" fill="rgba(110,231,199,0.13)" stroke="rgba(110,231,199,0.22)" stroke-width="0.5"/>`;
    const blade2 = i < N - 1 ? `<path d="M45 ${y0 - segH * 0.85} q ${-s * 8} -3.5 ${-s * 17} -1.5 q ${-s * 8} 2 ${-s * 13} 7 q ${s * 10} 2.5 ${s * 19} -0.5 q ${s * 7} -2 ${s * 11} -5 Z" fill="url(#klf-${uid})" opacity="${(0.42 + i * 0.05).toFixed(2)}"/>` : '';
    inner = `<g class="ks" style="transform-origin:45px ${y0}px;animation-delay:${(-i * dur / 9).toFixed(2)}s;--ka:${(1.1 + i * 0.24).toFixed(2)}deg">${stipe}${blade}${blade2}${inner}</g>`;
  }
  return `<div class="kelp-w" style="left:${xPct}%;height:${h}px;--kd:${dur}s;opacity:${opacity}"><svg viewBox="0 0 90 ${h}" style="width:100%;height:100%;overflow:visible">${defs}${inner}</svg></div>`;
};

const grassTuft = (xPct: number, h: number, n: number, uid: number): string => {
  let blades = '';
  for (let i = 0; i < n; i++) {
    const bx = 6 + (i * 58) / n + (((i * 7919) % 10) - 5) * 0.8;
    const lean = (((i * 104729) % 21) - 10) * 1.1;
    const bh = h * (0.6 + ((i * 31) % 10) / 22);
    const dur = (3.6 + ((i * 13) % 10) / 5).toFixed(2);
    const del = (-((i * 17) % 10) / 2.2).toFixed(2);
    const a = (0.4 + ((i * 23) % 10) / 25).toFixed(2);
    const g = 88 + ((i * 11) % 30);
    blades += `<path class="gb" style="transform-origin:${bx}px ${h}px;animation-duration:${dur}s;animation-delay:${del}s;--ka:${(1.8 + ((i * 29) % 10) / 6).toFixed(2)}deg"
      d="M${bx} ${h} q ${lean * 0.4} ${-bh * 0.55} ${lean} ${-bh}" stroke="rgba(38,${g},80,${a})" stroke-width="1.9" fill="none" stroke-linecap="round"/>`;
  }
  return `<div class="grass-w" style="left:${xPct}%;height:${h + 6}px"><svg viewBox="0 0 70 ${h + 6}" style="width:100%;height:100%;overflow:visible">${blades}</svg></div>`;
};

const broadleaf = (xPct: number, h: number, uid: number): string => {
  const mk = (bx: number, lean: number, bh: number, dur: string, del: string, op: number) => `<g class="gb" style="transform-origin:${bx}px ${h}px;animation-duration:${dur}s;animation-delay:${del}s;--ka:1.6deg">
    <path d="M${bx} ${h} C ${bx + lean * 0.3} ${h - bh * 0.3} ${bx + lean - 7} ${h - bh * 0.62} ${bx + lean - 3} ${h - bh * 0.8}
             C ${bx + lean + 1} ${h - bh * 0.95} ${bx + lean + 5} ${h - bh * 0.9} ${bx + lean + 4} ${h - bh * 0.72}
             C ${bx + lean + 9} ${h - bh * 0.5} ${bx + 7} ${h - bh * 0.22} ${bx + 4} ${h} Z" fill="url(#bl-${uid})" opacity="${op}"/></g>`;
  return `<div class="grass-w" style="left:${xPct}%;height:${h + 6}px"><svg viewBox="0 0 90 ${h + 6}" style="width:100%;height:100%;overflow:visible">
    <defs><linearGradient id="bl-${uid}" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="rgba(28,68,56,0.9)"/><stop offset="100%" stop-color="rgba(64,132,108,0.55)"/></linearGradient></defs>
    ${mk(30, 14, h * 0.92, '6.5s', '0s', 0.85)}${mk(44, -12, h * 0.78, '7.4s', '-2.1s', 0.7)}${mk(56, 9, h * 0.6, '5.8s', '-3.4s', 0.6)}
  </svg></div>`;
};

// ── Sea floor ───────────────────────────────────────────────────────────────
const FLOOR = `<svg class="floor" viewBox="0 0 1600 200" preserveAspectRatio="xMidYMax slice">
  <defs>
    <linearGradient id="fl-back" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(4,18,28,0)"/><stop offset="55%" stop-color="rgba(5,21,32,0.85)"/><stop offset="100%" stop-color="#04121C"/></linearGradient>
    <linearGradient id="fl-sand" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0B2434"/><stop offset="100%" stop-color="#0D2838"/></linearGradient>
  </defs>
  <path d="M0 200 L0 92 Q 300 62 640 84 Q 980 108 1280 76 Q 1450 62 1600 88 L1600 200 Z" fill="url(#fl-back)"/>
  <path d="M0 200 L0 128 Q 260 100 560 122 Q 900 146 1230 112 Q 1430 96 1600 124 L1600 200 Z" fill="#081E2E"/>
  <path d="M0 200 L0 156 Q 320 136 700 152 Q 1080 168 1400 148 Q 1520 142 1600 152 L1600 200 Z" fill="url(#fl-sand)"/>
  <path d="M110 174 Q 170 168 230 174" stroke="rgba(127,214,224,0.05)" stroke-width="1.5" fill="none"/>
  <path d="M420 184 Q 500 177 580 184" stroke="rgba(127,214,224,0.05)" stroke-width="1.5" fill="none"/>
  <path d="M760 170 Q 830 164 900 170" stroke="rgba(127,214,224,0.045)" stroke-width="1.5" fill="none"/>
  <path d="M1060 186 Q 1140 179 1220 186" stroke="rgba(127,214,224,0.05)" stroke-width="1.5" fill="none"/>
  <path d="M1330 172 Q 1400 166 1470 172" stroke="rgba(127,214,224,0.045)" stroke-width="1.5" fill="none"/>
  <path d="M150 178 C 152 160 172 150 196 153 C 222 156 236 168 233 180 C 214 186 168 186 150 178 Z" fill="#0A1D2B"/>
  <path d="M156 165 C 170 153 196 150 218 157" stroke="rgba(200,240,238,0.1)" stroke-width="1.2" fill="none"/>
  <ellipse cx="252" cy="182" rx="16" ry="6" fill="#0C2130"/><ellipse cx="128" cy="184" rx="11" ry="4.5" fill="#0C2130"/>
  <ellipse cx="205" cy="160" rx="4" ry="2.4" fill="rgba(6,14,22,0.8)" transform="rotate(-18 205 160)"/>
  <ellipse cx="188" cy="156" rx="3.4" ry="2" fill="rgba(6,14,22,0.8)" transform="rotate(12 188 156)"/>
  <path d="M1240 182 C 1240 164 1262 152 1288 155 C 1316 158 1332 172 1328 184 C 1304 190 1258 190 1240 182 Z" fill="#0A1D2B"/>
  <path d="M1248 168 C 1264 155 1292 152 1316 160" stroke="rgba(200,240,238,0.09)" stroke-width="1.2" fill="none"/>
  <ellipse cx="1358" cy="186" rx="18" ry="6" fill="#0C2130"/><ellipse cx="1212" cy="188" rx="12" ry="5" fill="#0C2130"/>
  <ellipse cx="1286" cy="162" rx="4.4" ry="2.5" fill="rgba(6,14,22,0.8)" transform="rotate(-14 1286 162)"/>
  <ellipse cx="700" cy="188" rx="9" ry="3.4" fill="#0B202F"/><ellipse cx="760" cy="192" rx="6" ry="2.6" fill="#0B202F"/><ellipse cx="860" cy="189" rx="7" ry="3" fill="#0B202F"/>
</svg>`;

// ── CSS ───────────────────────────────────────────────────────────────────
const CSS = `
:host{position:absolute;inset:0;display:block;overflow:hidden;pointer-events:none}
.bg{position:absolute;inset:0;overflow:hidden}
.layer{position:absolute;inset:0}
.rays .ray{position:absolute;top:-10%;width:140px;height:130%;background:linear-gradient(180deg, rgba(200,240,238,0.22), rgba(200,240,238,0) 70%);filter:blur(14px);transform-origin:top center;animation:ray-sway 14s ease-in-out infinite alternate}
.ray-1{left:12%;--r0:6deg;--r1:10deg;width:180px}
.ray-2{left:38%;--r0:-6deg;--r1:-2deg;width:240px;opacity:.85;animation-duration:18s}
.ray-3{left:62%;--r0:4deg;--r1:8deg;width:200px;opacity:.7;animation-duration:16s}
.ray-4{left:82%;--r0:-10deg;--r1:-6deg;width:160px;opacity:.6;animation-duration:12s}
@keyframes ray-sway{0%{transform:rotate(var(--r0)) translateX(-12px)}100%{transform:rotate(var(--r1)) translateX(12px)}}
.snow span{position:absolute;border-radius:50%;background:radial-gradient(circle, rgba(200,240,238,0.8), rgba(200,240,238,0));animation:snowdrift ease-in-out infinite alternate}
@keyframes snowdrift{0%{transform:translate3d(0,0,0)}100%{transform:translate3d(10px,16px,0)}}
.fish{position:absolute;left:0;top:0;will-change:transform}
.pitchg,.tailg,.pectg{transform-box:view-box}
.pectg{animation:pect-flap 1.7s ease-in-out infinite}
@keyframes pect-flap{0%,100%{transform:rotate(7deg)}50%{transform:rotate(-13deg)}}
.baittail{animation:btail .48s ease-in-out infinite alternate}
@keyframes btail{from{transform:rotate(-13deg)}to{transform:rotate(13deg)}}
.p-far{opacity:.6;filter:blur(1.7px) brightness(.72) saturate(.85)}
.p-mid{opacity:.85;filter:blur(.7px) brightness(.86)}
.p-near{opacity:1}
.plants{position:absolute;inset:0}
.kelp-w{position:absolute;bottom:8px;width:90px}
.kelp-far{filter:blur(2px) brightness(.6);opacity:.55}
.grass-w{position:absolute;bottom:6px;width:70px}
.ks{animation:kseg var(--kd) ease-in-out infinite alternate}
@keyframes kseg{from{transform:rotate(calc(var(--ka) * -1))}to{transform:rotate(var(--ka))}}
.gb{animation-name:kseg;animation-timing-function:ease-in-out;animation-iteration-count:infinite;animation-direction:alternate;animation-duration:4.5s}
.floor{position:absolute;bottom:0;left:0;width:100%;height:200px}
.caustic{position:absolute;left:0;right:0;bottom:0;height:150px;mix-blend-mode:screen;-webkit-mask-image:linear-gradient(transparent, rgba(0,0,0,0.85) 70%);mask-image:linear-gradient(transparent, rgba(0,0,0,0.85) 70%)}
.ca1{background:radial-gradient(circle 46px at 8% 78%, rgba(127,214,224,0.09), transparent 60%),radial-gradient(circle 60px at 26% 88%, rgba(127,214,224,0.07), transparent 60%),radial-gradient(circle 40px at 45% 80%, rgba(127,214,224,0.08), transparent 60%),radial-gradient(circle 56px at 64% 90%, rgba(127,214,224,0.07), transparent 60%),radial-gradient(circle 44px at 82% 82%, rgba(127,214,224,0.08), transparent 60%),radial-gradient(circle 52px at 96% 89%, rgba(127,214,224,0.06), transparent 60%);animation:caust 11s ease-in-out infinite alternate}
.ca2{background:radial-gradient(circle 52px at 16% 90%, rgba(110,231,199,0.06), transparent 60%),radial-gradient(circle 42px at 36% 82%, rgba(110,231,199,0.07), transparent 60%),radial-gradient(circle 58px at 55% 92%, rgba(110,231,199,0.05), transparent 60%),radial-gradient(circle 40px at 74% 84%, rgba(110,231,199,0.07), transparent 60%),radial-gradient(circle 50px at 90% 92%, rgba(110,231,199,0.05), transparent 60%);animation:caust 15s ease-in-out infinite alternate-reverse}
@keyframes caust{from{transform:translateX(-28px)}to{transform:translateX(28px)}}
.bubbles span{position:absolute;bottom:-30px;border-radius:50%;background:radial-gradient(circle at 35% 30%, rgba(255,255,255,0.5), rgba(180,230,240,0.14) 60%, transparent 72%);box-shadow:inset 0 0 6px rgba(255,255,255,0.14), 0 0 5px rgba(127,214,224,0.12);animation:brise linear infinite}
@keyframes brise{0%{transform:translate3d(0,0,0) scale(.65);opacity:0}8%{opacity:.85}30%{transform:translate3d(6px,-30vh,0) scale(.82)}55%{transform:translate3d(-5px,-55vh,0) scale(.95)}80%{transform:translate3d(5px,-80vh,0) scale(1.05);opacity:.5}100%{transform:translate3d(-2px,-104vh,0) scale(1.1);opacity:0}}
.tint{position:absolute;inset:0;background:linear-gradient(180deg, transparent 0%, rgba(2,10,18,0.38) 100%)}
.vignette{position:absolute;inset:0;background:radial-gradient(ellipse 120% 90% at 50% 42%, transparent 58%, rgba(2,8,14,0.5) 100%)}
@media (prefers-reduced-motion: reduce){
  .ray,.snow span,.pectg,.baittail,.ks,.gb,.ca1,.ca2,.bubbles span{animation:none !important}
  .bubbles span{display:none}
}`;

// ── Fish physics ───────────────────────────────────────────────────────────
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

class Swimmer {
  sp: SpeciesSpec;
  z: number;
  plane: PlaneKey;
  w: number;
  h: number;
  vmax: number;
  x: number;
  y: number;
  heading: number;
  spd: number;
  faceCur: number;
  pitch = 0;
  phase: number;
  tailA = 0;
  tx!: number;
  ty!: number;
  burst = false;
  mt!: number;
  el: HTMLDivElement | null = null;
  _pitch: SVGGElement | null = null;
  _tail: SVGGElement | null = null;

  constructor(species: SpeciesKey, plane: PlaneKey, W: number, H: number) {
    this.sp = SPECIES[species];
    this.z = PLANES[plane].z;
    this.plane = plane;
    this.w = this.sp.baseW * this.z * rand(0.88, 1.12);
    this.h = this.w * this.sp.ar;
    this.vmax = this.sp.vmax * (0.5 + this.z * 0.6);
    this.x = rand(0, W); this.y = this.bandY(H);
    this.heading = Math.random() > 0.5 ? 0 : Math.PI;
    this.spd = this.vmax * 0.3;
    this.faceCur = Math.cos(this.heading) >= 0 ? 1 : -1;
    this.phase = rand(0, Math.PI * 2); this.tailA = 0;
    this.newTarget(W, H); this.newMode();
  }
  bandY(H: number): number {
    const band = this.sp.band;
    if (band === 'upper') return rand(H * 0.04, H * 0.42);
    if (band === 'bottom') return Math.max(H * 0.5, rand(H - 215, H - 155) - this.h * 0.5);
    const floor = 160;
    return rand(H * 0.06, Math.max(H * 0.1, H - floor - this.h - 30));
  }
  newTarget(W: number, H: number): void {
    if (Math.random() < (this.sp.exitBias ?? 0.24)) { // traverse offscreen
      this.tx = this.faceCur > 0 ? W + this.w + 120 : -this.w - 120;
    } else {
      this.tx = rand(W * 0.05, W * 0.95);
    }
    this.ty = this.bandY(H);
  }
  newMode(): void {
    this.burst = !this.burst;
    const r = this.burst ? this.sp.burst : this.sp.coast;
    this.mt = rand(r[0], r[1]);
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
    this.mt -= dt; if (this.mt <= 0) this.newMode();
    const targetSpd = this.burst ? this.vmax : this.vmax * this.sp.coastFrac;
    this.spd += (targetSpd - this.spd) * Math.min(1, dt * (this.burst ? 4.5 : 1.6));
    const want = Math.atan2(this.ty - this.y, this.tx - this.x);
    let dh = want - this.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const maxTurn = this.sp.turn * dt;
    this.heading += Math.max(-maxTurn, Math.min(maxTurn, dh));
    const vx = Math.cos(this.heading) * this.spd, vy = Math.sin(this.heading) * this.spd;
    this.x += vx * dt; this.y += vy * dt + Math.sin(this.phase * 0.35) * this.sp.bob * dt;
    const face = Math.abs(vx) > 6 ? (vx > 0 ? 1 : -1) : (this.faceCur >= 0 ? 1 : -1);
    this.faceCur += (face - this.faceCur) * Math.min(1, dt * 3.2);
    const sr = this.spd / this.vmax;
    this.phase += dt * Math.PI * 2 * (0.7 + sr * this.sp.tailK);
    this.tailA = (2.5 + this.sp.amp * sr) * Math.sin(this.phase);
    const pm = this.sp.pitchMax;
    const tp = Math.max(-pm, Math.min(pm, Math.atan2(vy, Math.abs(vx) + 4) * 57.3 * 0.7));
    this.pitch += (tp - this.pitch) * Math.min(1, dt * 4);
    const dx = this.tx - this.x, dy = this.ty - this.y;
    if (dx * dx + dy * dy < 3600) this.newTarget(W, H);
    if (this.x < -this.w - 200 || this.x > W + this.w + 200) this.respawn(W, H);
    if (this.y < 10) this.y = 10;
  }
  apply(): void {
    if (!this.el || !this._pitch || !this._tail) return;
    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px,${this.y.toFixed(1)}px,0) scale(${(this.faceCur).toFixed(3)},1)`;
    this._pitch.style.transform = `rotate(${(this.pitch - this.tailA * 0.14).toFixed(2)}deg)`;
    this._tail.style.transform = `rotate(${this.tailA.toFixed(2)}deg)`;
  }
}

interface SchoolMember {
  el: HTMLDivElement;
  ox: number;
  oy: number;
  p1: number;
  p2: number;
  w1: number;
  w2: number;
  s: number;
}

const ROSTERS: Record<string, Array<[SpeciesKey, PlaneKey]>> = {
  low: [['salmon', 'mid'], ['bass', 'far'], ['bream', 'mid'], ['trout', 'mid'], ['salmon', 'far'], ['turbot', 'near'], ['tuna', 'far']],
  med: [['salmon', 'mid'], ['bass', 'far'], ['bream', 'mid'], ['trout', 'mid'], ['salmon', 'far'], ['turbot', 'near'], ['bass', 'near'], ['mackerel', 'mid'], ['mackerel', 'mid'], ['trout', 'near'], ['bream', 'far'], ['tuna', 'mid']],
  high: [['salmon', 'mid'], ['bass', 'far'], ['bream', 'mid'], ['trout', 'mid'], ['salmon', 'far'], ['turbot', 'near'], ['bass', 'near'], ['mackerel', 'mid'], ['mackerel', 'mid'], ['trout', 'near'], ['bream', 'far'], ['salmon', 'near'], ['bass', 'mid'], ['mackerel', 'far'], ['trout', 'far'], ['turbot', 'mid'], ['salmon', 'far'], ['tuna', 'near'], ['tuna', 'mid'], ['tuna', 'far']],
};

class ReefSceneElement extends HTMLElement {
  static get observedAttributes(): string[] { return ['density', 'plants']; }

  private _built = false;
  private _plantsLayer: HTMLElement | null = null;
  private _back: HTMLElement | null = null;
  private _front: HTMLElement | null = null;
  private _schoolLayer: HTMLElement | null = null;
  private _dims = { W: 1440, H: 900 };
  private _ro: ResizeObserver | null = null;
  private _mq: MediaQueryList | null = null;
  private _onMq: (() => void) | null = null;
  private _fish: Swimmer[] | null = null;
  private _anchor: Swimmer | null = null;
  private _members: SchoolMember[] = [];
  private _t = 0;
  private _raf: number | null = null;

  attributeChangedCallback(name: string): void {
    if (!this._built) return;
    if (name === 'density') this._buildFish();
    if (name === 'plants' && this._plantsLayer) {
      this._plantsLayer.style.display = this.getAttribute('plants') === 'false' ? 'none' : '';
    }
  }

  connectedCallback(): void {
    if (this._built) { this._start(); return; }
    this._built = true;
    const root = this.attachShadow({ mode: 'open' });
    const snow = Array.from({ length: 42 }, () => {
      const s = rand(1, 3);
      return `<span style="left:${rand(0, 100).toFixed(1)}%;top:${rand(0, 100).toFixed(1)}%;width:${s.toFixed(1)}px;height:${s.toFixed(1)}px;opacity:${rand(0.12, 0.4).toFixed(2)};animation-duration:${rand(14, 34).toFixed(1)}s;animation-delay:${(-rand(0, 20)).toFixed(1)}s"></span>`;
    }).join('');
    const vents = [[17, 5], [47, 3], [76, 5]].map(([x, n]) => Array.from({ length: n }, () => {
      const s = rand(2.5, 7);
      return `<span style="left:calc(${x}% + ${rand(-14, 14).toFixed(0)}px);width:${s.toFixed(1)}px;height:${s.toFixed(1)}px;animation-duration:${rand(6.5, 11).toFixed(1)}s;animation-delay:${(-rand(0, 11)).toFixed(1)}s"></span>`;
    }).join('')).join('');
    const singles = Array.from({ length: 6 }, () => {
      const s = rand(2, 5);
      return `<span style="left:${rand(4, 96).toFixed(0)}%;width:${s.toFixed(1)}px;height:${s.toFixed(1)}px;animation-duration:${rand(9, 15).toFixed(1)}s;animation-delay:${(-rand(0, 14)).toFixed(1)}s"></span>`;
    }).join('');
    let plants = '';
    let uid = 0;
    const kelps: Array<[number, number, number]> = [[1.5, 380, 7.5], [6, 300, 8.5], [11.5, 420, 6.8], [83, 340, 8], [90, 430, 7.2], [95.5, 310, 6.4]];
    kelps.forEach(([x, h, d]) => { uid += 1; plants += kelpStrand(x, h, d, uid, 0.92); });
    [[17, 250, 9], [77, 280, 8.2]].forEach(([x, h, d]) => {
      uid += 1;
      plants += kelpStrand(x, h, d, uid, 1).replace('class="kelp-w"', 'class="kelp-w kelp-far"');
    });
    [[15, 96, 12], [27, 74, 10], [44, 60, 9], [58, 68, 10], [70, 88, 12], [80, 70, 9]].forEach(([x, h, n]) => {
      uid += 1;
      plants += grassTuft(x, h, n, uid);
    });
    uid += 1;
    const bl1 = broadleaf(22, 110, uid);
    uid += 1;
    plants += bl1 + broadleaf(63, 96, uid);
    root.innerHTML = `<style>${CSS}</style><div class="bg">
      <div class="layer rays" style="opacity:.42"><div class="ray ray-1"></div><div class="ray ray-2"></div><div class="ray ray-3"></div><div class="ray ray-4"></div></div>
      <div class="layer snow">${snow}</div>
      <div class="layer school-far"></div>
      <div class="layer fish-back"></div>
      ${FLOOR}
      <div class="caustic ca1"></div><div class="caustic ca2"></div>
      <div class="layer plants">${plants}</div>
      <div class="layer fish-front"></div>
      <div class="layer bubbles">${vents}${singles}</div>
      <div class="tint"></div><div class="vignette"></div>
    </div>`;
    this._plantsLayer = root.querySelector('.plants');
    if (this.getAttribute('plants') === 'false' && this._plantsLayer) {
      this._plantsLayer.style.display = 'none';
    }
    this._back = root.querySelector('.fish-back');
    this._front = root.querySelector('.fish-front');
    this._schoolLayer = root.querySelector('.school-far');
    this._dims = { W: this.offsetWidth || 1440, H: this.offsetHeight || 900 };
    this._ro = new ResizeObserver((es) => { const e = es[0]; if (e) this._dims = { W: e.contentRect.width, H: e.contentRect.height }; });
    this._ro.observe(this);
    this._mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._onMq = () => this._start();
    this._mq.addEventListener('change', this._onMq);
    this._buildFish();
  }

  private _buildFish(): void {
    const { W, H } = this._dims;
    const density = this.getAttribute('density') || 'med';
    const schoolN = { low: 10, med: 14, high: 20 }[density] || 14;
    if (!this._back || !this._front || !this._schoolLayer || !this.shadowRoot) return;
    this._back.innerHTML = ''; this._front.innerHTML = ''; this._schoolLayer.innerHTML = '';
    let uid = 1000;
    this._fish = (ROSTERS[density] || ROSTERS.med).map(([sp, plane]) => {
      const f = new Swimmer(sp, plane, W, H);
      const el = document.createElement('div');
      el.className = `fish p-${plane}`;
      el.style.width = f.w + 'px'; el.style.height = f.h + 'px';
      uid += 1;
      el.innerHTML = SPECIES[sp].art(uid);
      const pect = el.querySelector('.pectg');
      if (pect) (pect as HTMLElement).style.animationDelay = (-rand(0, 1.7)).toFixed(2) + 's';
      (plane === 'near' ? this._front! : this._back!).appendChild(el);
      f.el = el;
      f._pitch = el.querySelector('.pitchg') as SVGGElement | null;
      f._tail = el.querySelector('.tailg') as SVGGElement | null;
      return f;
    });
    // Baitfish school — members orbit a wandering anchor
    this._anchor = new Swimmer('bass', 'far', W, H);
    this._anchor.vmax = 62; this._anchor.el = null;
    this._members = Array.from({ length: schoolN }, () => {
      const el = document.createElement('div');
      el.className = 'fish p-far';
      const w = rand(26, 42);
      el.style.width = w + 'px'; el.style.height = w * 0.28 + 'px';
      uid += 1;
      el.innerHTML = baitArt(uid);
      const baitTail = el.querySelector('.baittail');
      if (baitTail) (baitTail as HTMLElement).style.animationDelay = (-rand(0, 0.5)).toFixed(2) + 's';
      this._schoolLayer!.appendChild(el);
      return { el, ox: rand(-78, 78), oy: rand(-26, 26), p1: rand(0, 6.3), p2: rand(0, 6.3), w1: rand(0.8, 1.6), w2: rand(0.7, 1.4), s: rand(0.85, 1.15) };
    });
    this._t = 0;
    // Paint once synchronously so the scene is laid out even before the first rAF frame.
    this._paint();
    this._start();
  }

  private _paint(): void {
    this._fish?.forEach((f) => f.apply());
    const a = this._anchor;
    if (!a) return;
    this._members.forEach((m) => {
      const jx = Math.sin(this._t * m.w1 + m.p1) * 8, jy = Math.cos(this._t * m.w2 + m.p2) * 5;
      m.el.style.transform = `translate3d(${(a.x + m.ox + jx).toFixed(1)}px,${(a.y + m.oy + jy).toFixed(1)}px,0) scale(${(a.faceCur * m.s).toFixed(3)},${m.s.toFixed(3)})`;
    });
  }

  private _start(): void {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (!this._fish) return;
    if (this._mq?.matches) { this._paint(); return; }
    let last = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      this._t += dt;
      const { W, H } = this._dims;
      this._fish!.forEach((f) => f.step(dt, W, H));
      this._anchor?.step(dt, W, H);
      this._paint();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  disconnectedCallback(): void {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this._ro) this._ro.disconnect();
    if (this._mq && this._onMq) this._mq.removeEventListener('change', this._onMq);
  }
}

if (typeof window !== 'undefined' && window.customElements && !window.customElements.get('suderra-reef-scene')) {
  window.customElements.define('suderra-reef-scene', ReefSceneElement);
}

export {};
