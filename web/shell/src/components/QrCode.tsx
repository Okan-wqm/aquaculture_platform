import React, { useMemo } from 'react';

const ECC_LEVEL_L = 1;

const VERSION_INFO: Record<number, { dataCodewords: number; eccCodewordsPerBlock: number; blocks: number }> = {
  1: { dataCodewords: 19, eccCodewordsPerBlock: 7, blocks: 1 },
  2: { dataCodewords: 34, eccCodewordsPerBlock: 10, blocks: 1 },
  3: { dataCodewords: 55, eccCodewordsPerBlock: 15, blocks: 1 },
  4: { dataCodewords: 80, eccCodewordsPerBlock: 20, blocks: 1 },
  5: { dataCodewords: 108, eccCodewordsPerBlock: 26, blocks: 1 },
  6: { dataCodewords: 136, eccCodewordsPerBlock: 18, blocks: 2 },
  7: { dataCodewords: 156, eccCodewordsPerBlock: 20, blocks: 2 },
  8: { dataCodewords: 194, eccCodewordsPerBlock: 24, blocks: 2 },
  9: { dataCodewords: 232, eccCodewordsPerBlock: 30, blocks: 2 },
};

const ALIGNMENT_CENTERS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
};

interface BitBuffer {
  bits: number[];
  append(value: number, length: number): void;
}

function createBitBuffer(): BitBuffer {
  return {
    bits: [],
    append(value: number, length: number) {
      for (let i = length - 1; i >= 0; i--) {
        this.bits.push((value >>> i) & 1);
      }
    },
  };
}

function chooseVersion(byteLength: number): number {
  for (const [versionText, info] of Object.entries(VERSION_INFO)) {
    const version = Number(versionText);
    const requiredBits = 4 + 8 + byteLength * 8;
    if (requiredBits <= info.dataCodewords * 8) {
      return version;
    }
  }
  throw new Error('QR payload is too long');
}

function encodeData(value: string, version: number): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  const info = VERSION_INFO[version];
  if (!info) throw new Error('Unsupported QR version');

  const buffer = createBitBuffer();
  buffer.append(0b0100, 4);
  buffer.append(bytes.length, 8);
  for (const byte of bytes) {
    buffer.append(byte, 8);
  }

  const capacityBits = info.dataCodewords * 8;
  const terminatorLength = Math.min(4, capacityBits - buffer.bits.length);
  buffer.append(0, terminatorLength);
  while (buffer.bits.length % 8 !== 0) {
    buffer.bits.push(0);
  }

  const codewords: number[] = [];
  for (let i = 0; i < buffer.bits.length; i += 8) {
    codewords.push(Number.parseInt(buffer.bits.slice(i, i + 8).join(''), 2));
  }

  for (let pad = 0; codewords.length < info.dataCodewords; pad++) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
  }

  return codewords;
}

const gfExp = new Array<number>(512);
const gfLog = new Array<number>(256);

function initGalois(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    gfExp[i] = gfExp[i - 255]!;
  }
}

initGalois();

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return gfExp[(gfLog[a]! + gfLog[b]!) % 255]!;
}

function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const root = gfExp[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMultiply(poly[j]!, root);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data: number[], degree: number): number[] {
  const generator = generatorPolynomial(degree);
  const result = [...data, ...new Array<number>(degree).fill(0)];

  for (let i = 0; i < data.length; i++) {
    const coefficient = result[i]!;
    if (coefficient === 0) continue;
    for (let j = 0; j < generator.length; j++) {
      result[i + j] ^= gfMultiply(generator[j]!, coefficient);
    }
  }

  return result.slice(data.length);
}

function addErrorCorrection(version: number, data: number[]): number[] {
  const info = VERSION_INFO[version];
  if (!info) throw new Error('Unsupported QR version');

  const blockLength = info.dataCodewords / info.blocks;
  if (!Number.isInteger(blockLength)) {
    throw new Error('Unsupported QR block layout');
  }

  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  for (let i = 0; i < info.blocks; i++) {
    const block = data.slice(i * blockLength, (i + 1) * blockLength);
    blocks.push(block);
    eccBlocks.push(reedSolomon(block, info.eccCodewordsPerBlock));
  }

  const result: number[] = [];
  for (let i = 0; i < blockLength; i++) {
    for (const block of blocks) {
      result.push(block[i]!);
    }
  }
  for (let i = 0; i < info.eccCodewordsPerBlock; i++) {
    for (const block of eccBlocks) {
      result.push(block[i]!);
    }
  }
  return result;
}

interface Matrix {
  modules: boolean[][];
  functionModules: boolean[][];
}

function createMatrix(size: number): Matrix {
  return {
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    functionModules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setModule(matrix: Matrix, x: number, y: number, value: boolean, isFunction = false): void {
  if (y < 0 || y >= matrix.modules.length || x < 0 || x >= matrix.modules.length) return;
  matrix.modules[y]![x] = value;
  if (isFunction) {
    matrix.functionModules[y]![x] = true;
  }
}

function drawFinder(matrix: Matrix, x: number, y: number): void {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      const isFinder =
        dx >= 0 &&
        dx <= 6 &&
        dy >= 0 &&
        dy <= 6 &&
        (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setModule(matrix, xx, yy, isFinder, true);
    }
  }
}

function drawAlignment(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setModule(matrix, cx + dx, cy + dy, distance !== 1, true);
    }
  }
}

function drawFunctionPatterns(matrix: Matrix, version: number): void {
  const size = matrix.modules.length;
  drawFinder(matrix, 0, 0);
  drawFinder(matrix, size - 7, 0);
  drawFinder(matrix, 0, size - 7);

  for (let i = 8; i < size - 8; i++) {
    const value = i % 2 === 0;
    setModule(matrix, i, 6, value, true);
    setModule(matrix, 6, i, value, true);
  }

  const centers = ALIGNMENT_CENTERS[version] ?? [];
  for (const x of centers) {
    for (const y of centers) {
      const overlapsFinder =
        (x === 6 && y === 6) ||
        (x === 6 && y === size - 7) ||
        (x === size - 7 && y === 6);
      if (!overlapsFinder) {
        drawAlignment(matrix, x, y);
      }
    }
  }

  setModule(matrix, 8, size - 8, true, true);

  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      matrix.functionModules[8]![i] = true;
      matrix.functionModules[i]![8] = true;
    }
  }
  for (let i = 0; i < 8; i++) {
    matrix.functionModules[size - 1 - i]![8] = true;
    matrix.functionModules[8]![size - 1 - i] = true;
  }
}

function drawCodewords(matrix: Matrix, codewords: number[]): void {
  const bits = codewords.flatMap((codeword) =>
    Array.from({ length: 8 }, (_, index) => (codeword >>> (7 - index)) & 1),
  );
  const size = matrix.modules.length;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let dx = 0; dx < 2; dx++) {
        const x = right - dx;
        if (matrix.functionModules[y]![x]) continue;
        setModule(matrix, x, y, (bits[bitIndex] ?? 0) === 1);
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

function cloneMatrix(matrix: Matrix): Matrix {
  return {
    modules: matrix.modules.map((row) => [...row]),
    functionModules: matrix.functionModules.map((row) => [...row]),
  };
}

function applyMask(matrix: Matrix, mask: number): void {
  const size = matrix.modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!matrix.functionModules[y]![x] && maskBit(mask, x, y)) {
        matrix.modules[y]![x] = !matrix.modules[y]![x];
      }
    }
  }
}

function formatBits(mask: number): number {
  const data = (ECC_LEVEL_L << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
  }
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function drawFormatBits(matrix: Matrix, mask: number): void {
  const size = matrix.modules.length;
  const bits = formatBits(mask);

  for (let i = 0; i <= 5; i++) setModule(matrix, 8, i, ((bits >>> i) & 1) === 1, true);
  setModule(matrix, 8, 7, ((bits >>> 6) & 1) === 1, true);
  setModule(matrix, 8, 8, ((bits >>> 7) & 1) === 1, true);
  setModule(matrix, 7, 8, ((bits >>> 8) & 1) === 1, true);
  for (let i = 9; i < 15; i++) setModule(matrix, 14 - i, 8, ((bits >>> i) & 1) === 1, true);

  for (let i = 0; i < 8; i++) setModule(matrix, size - 1 - i, 8, ((bits >>> i) & 1) === 1, true);
  for (let i = 8; i < 15; i++) setModule(matrix, 8, size - 15 + i, ((bits >>> i) & 1) === 1, true);
  setModule(matrix, 8, size - 8, true, true);
}

function penalty(matrix: boolean[][]): number {
  const size = matrix.length;
  let score = 0;

  for (let y = 0; y < size; y++) {
    let runColor = matrix[y]![0]!;
    let runLength = 1;
    for (let x = 1; x < size; x++) {
      if (matrix[y]![x] === runColor) {
        runLength++;
      } else {
        if (runLength >= 5) score += 3 + (runLength - 5);
        runColor = matrix[y]![x]!;
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + (runLength - 5);
  }

  for (let x = 0; x < size; x++) {
    let runColor = matrix[0]![x]!;
    let runLength = 1;
    for (let y = 1; y < size; y++) {
      if (matrix[y]![x] === runColor) {
        runLength++;
      } else {
        if (runLength >= 5) score += 3 + (runLength - 5);
        runColor = matrix[y]![x]!;
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + (runLength - 5);
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = matrix[y]![x];
      if (matrix[y]![x + 1] === color && matrix[y + 1]![x] === color && matrix[y + 1]![x + 1] === color) {
        score += 3;
      }
    }
  }

  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const patternReversed = [...pattern].reverse();
  const matches = (line: boolean[], start: number, target: boolean[]): boolean =>
    target.every((value, index) => line[start + index] === value);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - pattern.length; x++) {
      if (matches(matrix[y]!, x, pattern) || matches(matrix[y]!, x, patternReversed)) score += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    const column = matrix.map((row) => row[x]!);
    for (let y = 0; y <= size - pattern.length; y++) {
      if (matches(column, y, pattern) || matches(column, y, patternReversed)) score += 40;
    }
  }

  const dark = matrix.flat().filter(Boolean).length;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

function generateQrMatrix(value: string): boolean[][] {
  const bytes = new TextEncoder().encode(value);
  const version = chooseVersion(bytes.length);
  const size = 17 + version * 4;
  const matrix = createMatrix(size);
  drawFunctionPatterns(matrix, version);
  drawCodewords(matrix, addErrorCorrection(version, encodeData(value, version)));

  let bestMatrix = matrix.modules;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = cloneMatrix(matrix);
    applyMask(candidate, mask);
    drawFormatBits(candidate, mask);
    const score = penalty(candidate.modules);
    if (score < bestPenalty) {
      bestPenalty = score;
      bestMatrix = candidate.modules;
    }
  }
  return bestMatrix;
}

export interface QrCodeProps {
  value: string;
  size?: number;
  className?: string;
}

export const QrCode: React.FC<QrCodeProps> = ({ value, size = 192, className = '' }) => {
  const matrix = useMemo(() => {
    try {
      return generateQrMatrix(value);
    } catch {
      return null;
    }
  }, [value]);

  if (!matrix) {
    return (
      <div
        role="img"
        aria-label="MFA QR code unavailable"
        className={`flex items-center justify-center bg-white text-xs text-gray-500 ${className}`}
        style={{ width: size, height: size }}
      >
        Manual key required
      </div>
    );
  }

  const modules = matrix.length;
  const quietZone = 4;
  const viewBoxSize = modules + quietZone * 2;
  const path = matrix
    .flatMap((row, y) =>
      row.map((dark, x) => (dark ? `M${x + quietZone},${y + quietZone}h1v1h-1z` : '')),
    )
    .filter(Boolean)
    .join('');

  return (
    <svg
      role="img"
      aria-label="MFA QR code"
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      width={size}
      height={size}
      className={className}
      shapeRendering="crispEdges"
    >
      <rect width={viewBoxSize} height={viewBoxSize} fill="#ffffff" />
      <path d={path} fill="#111827" />
    </svg>
  );
};
