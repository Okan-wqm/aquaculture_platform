/**
 * Parses the //!export-start to //!export-end block from FUXA SVG widgets
 * to extract configurable variables with their types and default values.
 *
 * FUXA uses a naming convention for variable types:
 *   _pn_ = number (int or float)
 *   _ps_ = string
 *   _pb_ = boolean
 *   _pc_ = color (hex with optional alpha, e.g., '#74b1e6ff')
 *
 * The parser extracts variable declarations from the export block,
 * determines types from prefixes, reads default values, generates
 * human-readable labels from camelCase names, and groups variables
 * semantically (stateColor, appearance, transform, custom).
 *
 * This parser is the foundation of the auto-generated config panel --
 * it turns any FUXA widget into a configurable component without
 * writing any per-widget code.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type FuxaVarType = 'number' | 'string' | 'boolean' | 'color';

export type FuxaVarGroup = 'stateColor' | 'appearance' | 'transform' | 'custom';

export interface FuxaExportVariable {
  /** Raw FUXA identifier including prefix, e.g. '_pc_state0' */
  id: string;
  /** Human-readable label derived from identifier, e.g. 'State 0' */
  label: string;
  /** Detected type from the prefix */
  type: FuxaVarType;
  /** Default value parsed from the declaration */
  defaultValue: string | number | boolean;
  /** Semantic group for config panel section rendering */
  group: FuxaVarGroup;
}

export interface ParsedExportBlock {
  variables: FuxaExportVariable[];
  /** The raw text between export-start and export-end markers */
  raw: string;
}

/* ------------------------------------------------------------------ */
/*  Prefix → type mapping                                              */
/* ------------------------------------------------------------------ */

/** Maps FUXA variable prefix to a strongly-typed variable type. */
const PREFIX_TYPE_MAP: Record<string, FuxaVarType> = {
  '_pn_': 'number',
  '_ps_': 'string',
  '_pb_': 'boolean',
  '_pc_': 'color',
};

/* ------------------------------------------------------------------ */
/*  Appearance and transform identifier sets                           */
/* ------------------------------------------------------------------ */

/**
 * Variable names (without prefix) that belong to the appearance group.
 * These control visual aspects like shading, padding, and aspect ratio.
 */
const APPEARANCE_NAMES = new Set([
  'lightShade',
  'highLightShade',
  'darkShade',
  'shadowShade',
  'padding',
  'preserveAspectRatio',
  'shade',
  'keepAspect',
]);

/**
 * Variable names (without prefix) that belong to the transform group.
 * These control spatial manipulation like rotation, offset, and flipping.
 */
const TRANSFORM_NAMES = new Set([
  'rotateAngle',
  'rotateOffsetX',
  'rotateOffsetY',
  'flipHorizontal',
  'flipVertical',
  'rotate',
  'flipX',
  'flipY',
]);

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Detect the FUXA variable type from its identifier prefix.
 * Falls back to 'string' for unrecognized prefixes -- ensures no
 * variable is silently dropped if the FUXA project adds new prefixes.
 */
export function detectVariableType(id: string): FuxaVarType {
  for (const [prefix, type] of Object.entries(PREFIX_TYPE_MAP)) {
    if (id.startsWith(prefix)) return type;
  }
  return 'string';
}

/**
 * Convert a FUXA variable identifier to a human-readable label.
 *
 * Steps:
 * 1. Strip the type prefix (_pn_, _ps_, _pb_, _pc_)
 * 2. Insert spaces before uppercase letters (camelCase splitting)
 * 3. Capitalize the first letter of each word
 *
 * Examples:
 *   _pn_setState      → 'Set State'
 *   _pc_state0        → 'State 0'
 *   _pb_flipHorizontal → 'Flip Horizontal'
 */
export function variableIdToLabel(id: string): string {
  // Strip the known prefix (_pX_) — always 4 characters
  const stripped = id.replace(/^_p[nsbce]_/, '');

  // Insert space before uppercase letters and before digits that follow letters
  const spaced = stripped
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2');

  // Capitalize first letter of each word
  return spaced
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Assign a semantic group to a variable based on its identifier.
 *
 * Grouping rules:
 * - _pc_state* → stateColor (the 6-state color palette)
 * - Known appearance names → appearance (shading, padding, aspect ratio)
 * - Known transform names → transform (rotation, offset, flip)
 * - Everything else → custom (widget-specific variables)
 */
export function groupVariable(id: string): FuxaVarGroup {
  // State color: any color variable starting with 'state'
  if (id.startsWith('_pc_state')) return 'stateColor';

  // Extract the name portion after the prefix
  const name = id.replace(/^_p[nsbce]_/, '');

  if (APPEARANCE_NAMES.has(name)) return 'appearance';
  if (TRANSFORM_NAMES.has(name)) return 'transform';

  return 'custom';
}

/* ------------------------------------------------------------------ */
/*  Value parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Parse the right-hand side of a `var _pX_name = <value>;` declaration.
 * Handles:
 * - Quoted strings (single or double): 'hello' or "hello"
 * - Numbers (int and float): 42, 3.14, -1
 * - Booleans: true, false
 * - Color hex strings: '#ff0000ff'
 */
function parseDefaultValue(
  raw: string,
  type: FuxaVarType,
): string | number | boolean {
  const trimmed = raw.trim().replace(/;$/, '').trim();

  switch (type) {
    case 'number': {
      const num = Number(trimmed);
      return Number.isNaN(num) ? 0 : num;
    }
    case 'boolean':
      return trimmed === 'true';
    case 'color':
      // Strip surrounding quotes from color strings
      return trimmed.replace(/^['"]|['"]$/g, '');
    case 'string':
      return trimmed.replace(/^['"]|['"]$/g, '');
    default:
      return trimmed.replace(/^['"]|['"]$/g, '');
  }
}

/* ------------------------------------------------------------------ */
/*  Main parser                                                        */
/* ------------------------------------------------------------------ */

/**
 * Parse the FUXA export block from an SVG widget's script content.
 *
 * Locates the `//!export-start` and `//!export-end` markers, extracts
 * each `var _pX_name = defaultValue;` declaration, and returns a
 * structured array of FuxaExportVariable objects.
 *
 * Returns an empty variables array if markers are not found -- this
 * is expected for non-FUXA SVG content or FUXA widgets that expose
 * no configurable variables.
 */
export function parseFuxaExports(svgContent: string): ParsedExportBlock {
  const startMarker = '//!export-start';
  const endMarker = '//!export-end';

  const startIdx = svgContent.indexOf(startMarker);
  const endIdx = svgContent.indexOf(endMarker);

  // No export block found — return empty result
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { variables: [], raw: '' };
  }

  const raw = svgContent.substring(
    startIdx + startMarker.length,
    endIdx,
  );

  const lines = raw.split('\n');
  const variables: FuxaExportVariable[] = [];

  // Regex matches: var _pX_variableName = defaultValue;
  // Allows optional inline comments after the value
  const varPattern = /^\s*var\s+(_(p[nsbce])_\w+)\s*=\s*(.+?);\s*(?:\/\/.*)?$/;

  for (const line of lines) {
    const match = line.match(varPattern);
    if (!match) continue;

    const id = match[1];
    const rawValue = match[3];
    const type = detectVariableType(id);

    variables.push({
      id,
      label: variableIdToLabel(id),
      type,
      defaultValue: parseDefaultValue(rawValue, type),
      group: groupVariable(id),
    });
  }

  return { variables, raw: raw.trim() };
}
