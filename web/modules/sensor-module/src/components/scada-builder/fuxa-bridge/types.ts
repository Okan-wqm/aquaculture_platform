/**
 * Type definitions for the FUXA SVG Widget integration system.
 *
 * FUXA widgets are community-contributed SVG files with embedded JavaScript
 * that execute inside sandboxed iframes. This type system defines the
 * communication protocol between our React runtime and the FUXA widget's
 * JavaScript engine.
 *
 * The FUXA convention uses variable name prefixes to encode type information:
 *   _pn_ = number, _ps_ = string, _pb_ = boolean, _pc_ = color
 *
 * Communication flow:
 *   React app  --putValue-->  iframe (sets variable)
 *   iframe     --postValue--> React app (user interaction feedback)
 *
 * Security boundary: The iframe sandbox attribute (allow-scripts only,
 * NO allow-same-origin) ensures FUXA JavaScript cannot access parent
 * window state, cookies, or localStorage.
 */

/* ------------------------------------------------------------------ */
/*  Variable type system                                               */
/* ------------------------------------------------------------------ */

/** Variable type prefixes from FUXA naming convention */
export type FuxaVarType = 'number' | 'string' | 'boolean' | 'color';

/** Mapping from FUXA variable prefix to our type system */
export const FUXA_PREFIX_MAP: Record<string, FuxaVarType> = {
  '_pn_': 'number',
  '_ps_': 'string',
  '_pb_': 'boolean',
  '_pc_': 'color',
};

/**
 * Parsed export variable from FUXA's //!export-start block.
 * Each variable represents a configurable property of the SVG widget
 * that can be driven by tag values from our SCADA runtime.
 */
export interface FuxaExportVariable {
  /** Variable identifier, e.g., '_pn_setState' */
  id: string;
  /** Derived from prefix: _pn_=number, _ps_=string, _pb_=boolean, _pc_=color */
  type: FuxaVarType;
  /** The initial value declared in the SVG script */
  defaultValue: string | number | boolean;
  /** Human-readable label derived from variable name (e.g., 'Set State') */
  label: string;
  /** Functional grouping for config panel organization */
  group: 'stateColor' | 'appearance' | 'transform' | 'custom';
}

/* ------------------------------------------------------------------ */
/*  postMessage protocol                                               */
/* ------------------------------------------------------------------ */

/**
 * Messages sent from our runtime INTO the FUXA iframe.
 * The relay script inside the iframe calls the SVG's putValue function
 * with these parameters.
 */
export interface FuxaInboundMessage {
  type: 'putValue';
  /** Variable ID (e.g., '_pn_setState') */
  id: string;
  /** Primitive value to set on the variable */
  value: string | number | boolean;
}

/**
 * Messages received FROM the FUXA iframe when the SVG's JavaScript
 * calls postValue (e.g., user drags a knob, clicks a button).
 */
export interface FuxaOutboundMessage {
  type: 'postValue';
  /** Variable ID that changed */
  id: string;
  /** New value from the SVG interaction */
  value: string | number | boolean;
}

/* ------------------------------------------------------------------ */
/*  State machine mapping                                              */
/* ------------------------------------------------------------------ */

/**
 * State mapping rule: maps a tag value to a FUXA 6-state index.
 * FUXA widgets typically support 6 visual states (0-5) that control
 * color, animation, and visibility of SVG elements.
 */
export interface FuxaStateRule {
  condition: 'lt' | 'lte' | 'eq' | 'gte' | 'gt' | 'between';
  /** Single threshold for lt/lte/eq/gte/gt, or [min, max] tuple for between */
  value: number | [number, number];
  /** Target FUXA state index (0-5) */
  state: 0 | 1 | 2 | 3 | 4 | 5;
}

/* ------------------------------------------------------------------ */
/*  Widget configuration (stored in SCADA package JSON)                */
/* ------------------------------------------------------------------ */

/**
 * Persisted configuration for a FUXA widget instance. Stored inside
 * the SCADA package JSON alongside other widget configs.
 */
export interface FuxaWidgetConfig {
  /** Full SVG content including embedded <script> block */
  svgContent: string;
  /** Reference to the catalog entry this widget was picked from */
  catalogId?: string;
  /** Category path for display in the config panel */
  category?: string;
  /** Current values for all parsed export variables */
  variables: Record<string, string | number | boolean>;
  /** Tag binding for the state machine (drives state index) */
  tagName?: string;
  /** Ordered rules that map tag values to FUXA states */
  stateRules?: FuxaStateRule[];
  /** Per-variable tag bindings (variable ID -> tag FQN) */
  variableTagBindings?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/*  Utility: parse export variables from SVG script                    */
/* ------------------------------------------------------------------ */

/**
 * Parses FUXA export variables from SVG content.
 *
 * FUXA SVGs declare exportable variables between //!export-start and
 * //!export-end comment markers. Each line contains a variable
 * declaration like: var _pn_setState = 0;
 *
 * This parser extracts those declarations, determines type from the
 * prefix, and returns structured metadata for config panel generation.
 */
export function parseFuxaExportVariables(svgContent: string): FuxaExportVariable[] {
  const variables: FuxaExportVariable[] = [];

  // Match the export block between markers
  const exportBlockMatch = svgContent.match(
    /\/\/!export-start([\s\S]*?)\/\/!export-end/
  );
  if (!exportBlockMatch) return variables;

  const block = exportBlockMatch[1];
  // Match variable declarations: var _pX_name = value;
  const varRegex = /var\s+(_p[nsbcNSBC]_\w+)\s*=\s*([^;]+);/g;
  let match: RegExpExecArray | null;

  while ((match = varRegex.exec(block)) !== null) {
    const id = match[1];
    const rawValue = match[2].trim();
    const prefix = id.substring(0, 4).toLowerCase();
    const varType = FUXA_PREFIX_MAP[prefix];

    if (!varType) continue;

    // Derive human-readable label from the variable name after prefix
    const nameAfterPrefix = id.substring(4);
    const label = nameAfterPrefix
      .replace(/([A-Z])/g, ' $1')
      .replace(/^_/, '')
      .trim();

    // Parse default value based on type
    let defaultValue: string | number | boolean;
    switch (varType) {
      case 'number':
        defaultValue = parseFloat(rawValue) || 0;
        break;
      case 'boolean':
        defaultValue = rawValue === 'true';
        break;
      case 'string':
      case 'color':
        // Strip quotes from string/color values
        defaultValue = rawValue.replace(/^['"]|['"]$/g, '');
        break;
    }

    // Determine group based on naming patterns
    let group: FuxaExportVariable['group'] = 'custom';
    const lowerName = nameAfterPrefix.toLowerCase();
    if (lowerName.includes('state') || lowerName.includes('color')) {
      group = 'stateColor';
    } else if (lowerName.includes('opacity') || lowerName.includes('visible') || lowerName.includes('font')) {
      group = 'appearance';
    } else if (lowerName.includes('rotate') || lowerName.includes('scale') || lowerName.includes('translate')) {
      group = 'transform';
    }

    variables.push({ id, type: varType, defaultValue, label, group });
  }

  return variables;
}

/* ------------------------------------------------------------------ */
/*  Utility: evaluate state rules                                      */
/* ------------------------------------------------------------------ */

/**
 * Evaluates an ordered list of state rules against a numeric tag value.
 * Returns the FUXA state index (0-5) for the first matching rule,
 * or 0 as the default state when no rule matches.
 *
 * Rules are evaluated in order, so more specific rules should appear
 * first in the array.
 */
export function evaluateStateRules(
  tagValue: number,
  rules: FuxaStateRule[],
): 0 | 1 | 2 | 3 | 4 | 5 {
  for (const rule of rules) {
    let matches = false;

    switch (rule.condition) {
      case 'lt':
        matches = tagValue < (rule.value as number);
        break;
      case 'lte':
        matches = tagValue <= (rule.value as number);
        break;
      case 'eq':
        matches = tagValue === (rule.value as number);
        break;
      case 'gte':
        matches = tagValue >= (rule.value as number);
        break;
      case 'gt':
        matches = tagValue > (rule.value as number);
        break;
      case 'between': {
        const [min, max] = rule.value as [number, number];
        matches = tagValue >= min && tagValue <= max;
        break;
      }
    }

    if (matches) return rule.state;
  }

  // Default state when no rule matches
  return 0;
}
