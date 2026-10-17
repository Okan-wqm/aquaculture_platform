/**
 * Content model of the two platform reference documents rendered under
 * /tenant/architecture: "Platform architecture v4" and its "Architecture
 * review". Both are static reference documentation — no backend owns them —
 * so their body is typed content in `content/`, kept in Turkish, the
 * documents' own language. Only the chrome around it is localized.
 */

/** How a diagram box is drawn: what kind of thing it stands for. */
export type BoxKind =
  | 'place'
  | 'asset'
  | 'data'
  | 'org'
  | 'assign'
  | 'calc'
  | 'ext'
  | 'hub'
  | 'warn'
  | 'hatch';

/** A link's line style: linked, data flow, assignment, setting/command. */
export type LinkKind = 'solid' | 'data' | 'assign' | 'ctrl';

/** A box side: left, right, top, bottom. */
export type BoxSide = 'l' | 'r' | 't' | 'b';

/** A box on a section diagram's fixed canvas. */
export interface DiagramBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly title: string;
  /** Small caps kicker naming the section the box points to ('' = none) */
  readonly ref: string;
  readonly sub: string;
  /** Example line, e.g. 'P-101 · MP-1' ('' = none) */
  readonly ex: string;
  readonly kind: BoxKind;
  readonly pills: readonly string[];
}

/**
 * A link between two boxes, routed orthogonally from a point on the source
 * side to a point on the target side. `ff`/`tf` place those points as a
 * fraction of the side; `mx`/`my` fix the elbow; `at` fixes the label.
 */
export interface DiagramLink {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly k: LinkKind;
  readonly fs: BoxSide;
  readonly ts: BoxSide;
  readonly ff: number;
  readonly tf: number;
  readonly mx?: number;
  readonly my?: number;
  readonly at?: readonly [number, number];
}

/** A labelled dashed frame grouping boxes on the canvas. */
export interface DiagramGroup {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly label: string;
}

/** A table that belongs to a section's body (§08's report tables). */
export interface SectionTable {
  readonly title: string;
  readonly sub?: string;
  readonly cols: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** One row of §14's "which section gives which what" table. */
export type SectionFlowRow = readonly [from: string, to: string, what: string];

export interface ArchitectureSection {
  /** Two-digit section number, also the anchor key ('01'…'14') */
  readonly num: string;
  readonly title: string;
  readonly intro: string;
  readonly width: number;
  readonly height: number;
  readonly groups?: readonly DiagramGroup[];
  readonly boxes: readonly DiagramBox[];
  readonly links: readonly DiagramLink[];
  readonly notes: readonly string[];
  readonly rules?: readonly string[];
  readonly tables?: readonly SectionTable[];
  readonly flows?: readonly SectionFlowRow[];
}

/** A review finding's kind: Çelişki, Boşluk, Kural eksik, Uç durum. */
export type FindingKind = 'c' | 'b' | 'k' | 'u';

export type FindingRow = readonly [kind: FindingKind, title: string, text: string, fix: string];

/** The review's findings for one v3 section. */
export interface ReviewSection {
  readonly num: string;
  readonly title: string;
  readonly intro: string;
  readonly items: readonly FindingRow[];
}

/** A review anchor: 'r01'…'r11' (a section), 'rk' (cross-cutting topics). */
export type ReviewAnchor = `r${string}`;

export type CrossTopicRow = readonly [id: string, title: string, text: string, affects: string];

export interface ProposedSection {
  readonly num: string;
  readonly title: string;
  readonly text: string;
  readonly parts: readonly string[];
}

export type ProposedFlowRow = readonly [from: string, to: string, what: string, why: string];

/** How far the architecture covers a scenario. */
export type ScenarioStatus = 'ok' | 'part' | 'no';

export type ScenarioRow = readonly [
  title: string,
  text: string,
  status: ScenarioStatus,
  refs: string,
  anchor: ReviewAnchor,
];

export type PriorityRow = readonly [
  title: string,
  text: string,
  refs: string,
  anchor: ReviewAnchor,
];
