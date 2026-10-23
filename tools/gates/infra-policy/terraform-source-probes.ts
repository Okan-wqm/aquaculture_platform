/**
 * Terraform module sources that each carry one planted marker in one syntactic position, the
 * corpus terraform-pins.ts's reported source is held to (ARIA-HIGH-012, round-4 review R1
 * residual, kc/r12r3-review/REVIEW.txt).
 *
 * WHY a corpus and not more examples: three review rounds each found a new position from which
 * masking the written address handed a credential on (an `@` in a query value or fragment, an
 * allow-listed argument whose value carries `?`, `;` or a nested URL, a scheme-less token user).
 * A reported source built only from parts that pass a strict shape check has no such position;
 * this corpus plants a distinct marker in every position a module source has, under every
 * go-getter forced prefix, so the next position is tried before a reviewer finds it.
 *
 * WHAT each probe holds: a module label, the source as written, the marker planted in it, and
 * the verdict terraform-pins.ts reached on that source before the reported form was rebuilt
 * (e7e14ff83). The verdict is judged on the parsed source and must not move: the reported form
 * is an output of the owner, never an input to its verdict.
 *
 * Shared by infra-policy.spec.ts (the owner) and
 * tools/aria-adapters/infrastructure-policy-adapter.test.ts (the adapter), so both hold the same
 * corpus. A marker is never a readable part: where a position is readable when well formed (a
 * host, a path segment, an allow-listed argument's value), its marker rides on a character that
 * position's shape refuses, so a correct owner replaces the whole part.
 */
import type { ModuleSourceVerdict } from './terraform-pins';

export interface TerraformSourceProbe {
  /** An HCL module label, unique in the corpus. */
  readonly name: string;
  /** The source address as written in the `.tf` file. */
  readonly source: string;
  /** The credential stand-in planted in `source`; no four-character window of it may be output. */
  readonly marker: string;
  /** The verdict judged on the whole source before the reported form was rebuilt. */
  readonly verdict: ModuleSourceVerdict;
}

const MARKER_LETTERS = 'ghjkmnpqrstvwxyz';
const MARKER_DIGITS = '23456789';
const MARKER_LENGTH = 10;
const MARKER_POOL_SIZE = 600;

/**
 * Markers whose four-character windows are each unique across the pool and each hold a letter
 * from g-z and a digit from 2-9. A window of one marker is then never part of another marker, so
 * a leak is attributed to the probe that planted it; and no host, path, version, hex checksum,
 * expiry or placeholder in the output has such a window. Drawn from a fixed-seed generator, so
 * the corpus is the same on every run.
 */
function markerPool(): readonly string[] {
  let seed = 0x5eed1234;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (alphabet: string): string => alphabet.charAt(Math.floor(next() * alphabet.length));
  const seen = new Set<string>();
  const pool: string[] = [];
  while (pool.length < MARKER_POOL_SIZE) {
    let candidate = '';
    for (let i = 0; i < MARKER_LENGTH; i += 1) {
      candidate += pick(i % 3 === 1 ? MARKER_DIGITS : MARKER_LETTERS + MARKER_DIGITS);
    }
    const windows = markerWindows(candidate);
    const shaped = windows.every((w) => /[g-z]/.test(w) && /[2-9]/.test(w));
    if (!shaped || windows.some((w) => seen.has(w)) || new Set(windows).size !== windows.length) {
      continue;
    }
    for (const w of windows) seen.add(w);
    pool.push(candidate.replace(/[g-z]/g, (c, at: number) => (at % 2 === 0 ? c.toUpperCase() : c)));
  }
  return pool;
}

/** The four-character windows of `text`, case folded, in order. */
export function markerWindows(text: string): string[] {
  const folded = text.toLowerCase();
  const windows: string[] = [];
  for (let i = 0; i + 4 <= folded.length; i += 1) windows.push(folded.slice(i, i + 4));
  return windows;
}

const MARKERS = markerPool();

/** The marker for probe `index`: a distinct, never-readable credential stand-in. */
export function plantedMarker(index: number): string {
  const marker = MARKERS[index];
  if (marker === undefined) throw new RangeError(`no planted marker ${index} in the pool`);
  return marker;
}

/** A hex SHA-256, a well-formed `checksum=sha256:` value. */
export const CHECKSUM_HEX = 'c'.repeat(64);

/** The go-getter forced getter prefixes each URL-shaped position is tried under. */
export const FORCED_PREFIXES = ['', 'git::', 's3::', 'gcs::', 'hg::'] as const;
type ForcedPrefix = (typeof FORCED_PREFIXES)[number];

const ARCHIVE = 'https://example.com/org/mod.zip';

type VerdictsByPrefix = readonly [
  ModuleSourceVerdict,
  ModuleSourceVerdict,
  ModuleSourceVerdict,
  ModuleSourceVerdict,
  ModuleSourceVerdict,
];

/** Verdicts for a position whose source names no `ref` and no checksum. */
const PLAIN = ['archive', 'git_unpinned', 'archive', 'archive', 'archive'] as const;
/** Verdicts for a position whose `ref` value is not a tag or commit. */
const BRANCH = ['archive', 'git_branch_ref', 'archive', 'archive', 'archive'] as const;
/** Verdicts for a position whose `ref` value starts like a version tag. */
const TAGGED = ['archive', 'git_tag', 'archive', 'archive', 'archive'] as const;
/** Verdicts for a position whose `checksum` value carries a `:`. */
const CHECKSUMMED = [
  'archive_checksummed',
  'git_unpinned',
  'archive_checksummed',
  'archive_checksummed',
  'archive_checksummed',
] as const;

/**
 * The positions of a URL-shaped source, each a function of the marker. `verdicts` is the verdict
 * terraform-pins.ts gives under the forced prefixes '' / git:: / s3:: / gcs:: / hg::, in order.
 */
const URL_POSITIONS: ReadonlyArray<{
  readonly position: string;
  readonly at: (m: string) => string;
  readonly verdicts: VerdictsByPrefix;
}> = [
  // URL userinfo
  {
    position: 'userinfo_password',
    at: (m) => `https://deploy:${m}@example.com/org/mod.zip`,
    verdicts: PLAIN,
  },
  {
    position: 'userinfo_user',
    at: (m) => `https://${m}:pw@example.com/org/mod.zip`,
    verdicts: PLAIN,
  },
  {
    position: 'user_without_password',
    at: (m) => `https://${m}@example.com/org/mod.zip`,
    verdicts: PLAIN,
  },
  {
    position: 'userinfo_percent_encoded',
    at: (m) => `https://user%3A${m}@example.com/org/mod.zip`,
    verdicts: PLAIN,
  },
  {
    position: 'userinfo_upper_scheme',
    at: (m) => `HTTPS://user:${m}@example.com/org/mod.zip`,
    // Unprefixed, an upper-case scheme is no archive form the owner classifies.
    verdicts: ['unknown', 'git_unpinned', 'archive', 'archive', 'archive'],
  },
  // host and path: readable when well formed, so the marker rides on a refused character
  {
    position: 'host_bad_character',
    at: (m) => `https://${m}!.example.com/org/mod.zip`,
    verdicts: PLAIN,
  },
  {
    position: 'port_not_digits',
    at: (m) => `https://example.com:${m}/org/mod.zip`,
    verdicts: PLAIN,
  },
  { position: 'path_parameter', at: (m) => `${ARCHIVE};token=${m}`, verdicts: PLAIN },
  {
    position: 'path_at_sign',
    at: (m) => `https://example.com/org/x@${m}/mod.zip`,
    verdicts: PLAIN,
  },
  // query arguments that are not allow-listed
  { position: 'query_value', at: (m) => `${ARCHIVE}?token=${m}`, verdicts: PLAIN },
  { position: 'query_name', at: (m) => `${ARCHIVE}?${m}=1`, verdicts: PLAIN },
  { position: 'query_bare', at: (m) => `${ARCHIVE}?${m}`, verdicts: PLAIN },
  { position: 'query_value_at_sign', at: (m) => `${ARCHIVE}?password=pre@${m}`, verdicts: PLAIN },
  { position: 'query_value_question', at: (m) => `${ARCHIVE}?token=a?${m}`, verdicts: PLAIN },
  { position: 'query_value_semicolon', at: (m) => `${ARCHIVE}?x=1;${m}`, verdicts: PLAIN },
  { position: 'query_value_hash', at: (m) => `${ARCHIVE}?token=a#${m}`, verdicts: PLAIN },
  {
    position: 'query_value_encoded_space',
    at: (m) => `${ARCHIVE}?Authorization=Bearer%20${m}`,
    verdicts: PLAIN,
  },
  {
    position: 'gcs_v2_signature',
    at: (m) =>
      `${ARCHIVE}?GoogleAccessId=sa@proj.iam.gserviceaccount.com&Expires=1700000000&Signature=${m}`,
    verdicts: PLAIN,
  },
  {
    position: 'gcs_v2_access_id',
    at: (m) => `${ARCHIVE}?GoogleAccessId=${m}@proj.iam.gserviceaccount.com&Signature=x`,
    verdicts: PLAIN,
  },
  {
    position: 's3_presigned_credential',
    at: (m) => `${ARCHIVE}?X-Amz-Credential=${m}%2F20261022&X-Amz-Signature=abc`,
    verdicts: PLAIN,
  },
  {
    position: 'secret_after_allow_listed',
    at: (m) => `${ARCHIVE}?ref=v1.2.3&depth=1&private_token=${m}`,
    verdicts: TAGGED,
  },
  // allow-listed arguments whose value does not have that argument's shape
  { position: 'ref_nested_question', at: (m) => `${ARCHIVE}?ref=x?token=${m}`, verdicts: BRANCH },
  { position: 'ref_semicolon', at: (m) => `${ARCHIVE}?ref=v1;token=${m}`, verdicts: BRANCH },
  { position: 'ref_at_sign', at: (m) => `${ARCHIVE}?ref=a@${m}`, verdicts: BRANCH },
  { position: 'ref_equals', at: (m) => `${ARCHIVE}?ref=a=${m}`, verdicts: BRANCH },
  {
    position: 'rev_nested_question',
    at: (m) => `${ARCHIVE}?rev=default?password=${m}`,
    verdicts: PLAIN,
  },
  { position: 'depth_not_digits', at: (m) => `${ARCHIVE}?depth=1${m}`, verdicts: PLAIN },
  { position: 'archive_not_a_type', at: (m) => `${ARCHIVE}?archive=${m}`, verdicts: PLAIN },
  {
    position: 'filename_nested_question',
    at: (m) => `${ARCHIVE}?filename=x?token=${m}`,
    verdicts: PLAIN,
  },
  {
    position: 'checksum_not_hex',
    at: (m) => `${ARCHIVE}?checksum=sha256:${m}`,
    verdicts: CHECKSUMMED,
  },
  {
    position: 'checksum_file_query',
    at: (m) => `${ARCHIVE}?checksum=file:https://b.s3.amazonaws.com/SUMS?X-Amz-Credential=${m}`,
    verdicts: CHECKSUMMED,
  },
  {
    position: 'checksum_file_userinfo',
    at: (m) => `${ARCHIVE}?checksum=file:https://u:${m}@h.example/SUMS`,
    verdicts: CHECKSUMMED,
  },
  {
    position: 'checksum_file_path',
    at: (m) => `${ARCHIVE}?checksum=file:https://h.example/${m}/SUMS`,
    verdicts: CHECKSUMMED,
  },
  // fragment
  { position: 'fragment', at: (m) => `${ARCHIVE}#${m}`, verdicts: PLAIN },
  { position: 'fragment_at_sign', at: (m) => `${ARCHIVE}#x@${m}`, verdicts: PLAIN },
];

/** Positions of the scheme-less forms (scp-style, VCS shorthands, registry), each written once. */
const SCHEMELESS_POSITIONS: ReadonlyArray<{
  readonly position: string;
  readonly at: (m: string) => string;
  readonly verdict: ModuleSourceVerdict;
}> = [
  {
    position: 'scp_user',
    at: (m) => `${m}@github.com:org/x.git?ref=main`,
    verdict: 'git_branch_ref',
  },
  {
    position: 'scp_user_forced',
    at: (m) => `git::${m}@github.com:org/x.git?ref=main`,
    verdict: 'git_branch_ref',
  },
  {
    position: 'scp_user_password',
    at: (m) => `git:${m}@github.com:org/x.git?ref=v1.2.3`,
    verdict: 'git_tag',
  },
  {
    position: 'token_user_shorthand',
    at: (m) => `ghp_${m}@github.com/org/x.git`,
    verdict: 'git_unpinned',
  },
  {
    position: 'github_query_token',
    at: (m) => `github.com/org/x?ref=v1.2.3&token=${m}`,
    verdict: 'git_tag',
  },
  {
    position: 'bitbucket_oauth',
    at: (m) => `bitbucket.org/org/x?ref=dev&oauth=${m}`,
    verdict: 'git_branch_ref',
  },
  {
    position: 'ssh_password',
    at: (m) => `git::ssh://git:${m}@example.com/org/x.git?ref=main`,
    verdict: 'git_branch_ref',
  },
  {
    position: 'ssh_user',
    at: (m) => `git::ssh://${m}@example.com/org/x.git`,
    verdict: 'git_unpinned',
  },
  {
    position: 's3_userinfo_key_id',
    at: (m) => `s3::https://AKIA${m}:secret@s3.amazonaws.com/b/m.zip`,
    verdict: 'archive',
  },
  {
    position: 'hg_password',
    at: (m) => `hg::https://example.com/repo?rev=default&password=${m}`,
    verdict: 'archive',
  },
  {
    position: 'registry_subdir_query',
    at: (m) => `terraform-aws-modules/vpc/aws//modules/x?token=${m}`,
    verdict: 'registry_unversioned',
  },
];

function prefixLabel(prefix: ForcedPrefix): string {
  return prefix === '' ? 'plain' : prefix.slice(0, -2);
}

/** The generated corpus: every URL-shaped position under every forced prefix, then the rest. */
export function terraformSourceProbes(): TerraformSourceProbe[] {
  const probes: TerraformSourceProbe[] = [];
  for (const { position, at, verdicts } of URL_POSITIONS) {
    FORCED_PREFIXES.forEach((prefix, column) => {
      const marker = plantedMarker(probes.length);
      const verdict = verdicts[column];
      if (verdict === undefined) throw new RangeError(`${position} has no verdict for ${prefix}`);
      probes.push({
        name: `${prefixLabel(prefix)}_${position}`,
        source: `${prefix}${at(marker)}`,
        marker,
        verdict,
      });
    });
  }
  for (const { position, at, verdict } of SCHEMELESS_POSITIONS) {
    const marker = plantedMarker(probes.length);
    probes.push({ name: position, source: at(marker), marker, verdict });
  }
  return probes;
}

/**
 * The round-4 reviewer's own leaking sources (kc/r12r3-review probe-leak-1..3.log, ws/ws2/ws3
 * main.tf), each with a fresh marker where the reviewer planted `LEAK…`, and their verdicts.
 */
export function reviewerProbes(): TerraformSourceProbe[] {
  const rows: ReadonlyArray<readonly [string, (m: string) => string, ModuleSourceVerdict]> = [
    // (a) an `@` in a query value or fragment swallowed the `?`
    [
      'gcs_v2_signed_url',
      (m) =>
        `https://storage.googleapis.com/b/m.zip?GoogleAccessId=sa@proj.iam.gserviceaccount.com&Expires=1700000000&Signature=${m}`,
      'archive',
    ],
    ['password_at_in_query', (m) => `https://example.com/m.zip?password=pre@${m}`, 'archive'],
    [
      'token_at_in_query',
      (m) => `git::https://github.com/org/x.git?ref=main&token=a@${m}`,
      'git_branch_ref',
    ],
    ['at_in_fragment', (m) => `https://example.com/m.zip#x@${m}`, 'archive'],
    // (b) an allow-listed argument kept whatever value it held
    [
      'checksum_file_presigned',
      (m) =>
        `git::https://example.com/x.git?ref=main&checksum=file:https://b.s3.amazonaws.com/SUMS?X-Amz-Credential=${m}&X-Amz-Signature=abc`,
      'git_branch_ref',
    ],
    [
      'checksum_file_archive',
      (m) =>
        `https://example.com/m.zip?checksum=file:https://b.s3.amazonaws.com/SUMS?X-Amz-Credential=${m}`,
      'archive_checksummed',
    ],
    ['ref_question_token', (m) => `https://example.com/m.zip?ref=x?token=${m}`, 'archive'],
    ['ref_semicolon_token', (m) => `https://example.com/m.zip?ref=v1;token=${m}`, 'archive'],
    // (c) a scheme-less user name without `:` was kept for any user
    ['token_user_github', (m) => `ghp_${m}@github.com/org/x.git`, 'git_unpinned'],
    [
      'token_scp_forced_branch',
      (m) => `git::ghp_${m}@github.com:org/x.git?ref=main`,
      'git_branch_ref',
    ],
    ['token_scp_forced_tag', (m) => `git::${m}@github.com:org/x.git?ref=v1.0.0`, 'git_tag'],
    // the rest of the reviewer's corpus, which did not leak on e7e14ff83 and must not start to
    [
      'https_token_user',
      (m) => `git::https://ghp_${m}@github.com/org/x.git?ref=main`,
      'git_branch_ref',
    ],
    [
      'authorization_header',
      (m) => `https://example.com/m.zip?archive=zip&Authorization=Bearer%20${m}`,
      'archive',
    ],
    ['upper_scheme_password', (m) => `HTTPS://user:${m}@example.com/m.zip`, 'unknown'],
    [
      'gcs_signature',
      (m) =>
        `gcs::https://www.googleapis.com/storage/v1/b/m.zip?GoogleAccessId=svc&Signature=${m}&Expires=1`,
      'archive',
    ],
    ['s3_userinfo', (m) => `s3::https://AKIA${m}:secret@s3.amazonaws.com/b/m.zip`, 'archive'],
    [
      'checksum_file_userinfo',
      (m) => `https://example.com/m.zip?filename=x&checksum=file:https://u:${m}@h/SUMS`,
      'archive_checksummed',
    ],
    ['hg_password', (m) => `hg::https://example.com/repo?rev=default&password=${m}`, 'archive'],
    [
      'git_private_token',
      (m) => `git::https://example.com/x.git?depth=1&ref=main&private_token=${m}`,
      'git_branch_ref',
    ],
    ['bare_argument', (m) => `https://example.com/m.zip?${m}`, 'archive'],
    ['percent_encoded_userinfo', (m) => `https://user%3A${m}@example.com/m.zip`, 'archive'],
    ['bitbucket_oauth', (m) => `bitbucket.org/org/x?ref=dev&oauth=${m}`, 'git_branch_ref'],
    [
      'gcs_v2_encoded_at',
      (m) =>
        `https://storage.googleapis.com/b/m.zip?GoogleAccessId=sa%40proj.iam.gserviceaccount.com&Expires=1700000000&Signature=${m}`,
      'archive',
    ],
  ];
  return rows.map(([name, at, verdict], index) => {
    const marker = plantedMarker(500 + index);
    return { name: `reviewer_${name}`, source: at(marker), marker, verdict };
  });
}

/**
 * HCL escapes as written in a `.tf` file. Terraform evaluates `@` and `\U00000040` to `@`,
 * `:` to `:`, `?` to `?` and `#` to `#` (HCL native syntax, quoted template
 * escapes), so an address written with them is, to Terraform, the address with those characters.
 */
const HCL_AT = '\\u0040';
const HCL_AT_LONG = '\\U00000040';
const HCL_COLON = '\\u003a';
const HCL_QUESTION = '\\u003f';
const HCL_HASH = '\\u0023';

/** Verdicts for a source ending in `.git?ref=main`: every prefix reads it as a git branch ref. */
const GIT_BRANCH = [
  'git_branch_ref',
  'git_branch_ref',
  'git_branch_ref',
  'git_branch_ref',
  'git_branch_ref',
] as const;
/** Verdicts for a scheme-less source ending in `.git` with no `ref`. */
const GIT_UNPINNED = [
  'git_unpinned',
  'git_unpinned',
  'git_unpinned',
  'git_unpinned',
  'git_unpinned',
] as const;

/**
 * The round-5 review's positions (ARIA-HIGH-012 R1 residual-2, kc/r12r4-review/REVIEW.txt and
 * 05-probe-leak.log, on 212a147e3): an authority or scheme-less head checked per half. The owner
 * split the authority at its last `:` and reported the left half whenever it had a hostname's
 * shape, though the right half failed the port's, and split a scheme-less head at its first `:`
 * the same way; and it parsed the token text, not the value Terraform evaluates. So a userinfo
 * whose `@` is written `%40` or as an HCL escape, or a user:password with no host at all, put
 * the user in the host slot. Each position plants the marker as that user (GitHub's documented
 * `https://<token>:x-oauth-basic@github.com` form among them), with the `@` percent-encoded,
 * HCL-escaped (`@`, `\U00000040`), or absent so only the port shape fails. The siblings
 * carry a `?` or `#` written as an HCL escape: once the reader decodes it, the part after it is
 * a query argument or a fragment and is withheld as one.
 */
const AUTHORITY_POSITIONS: ReadonlyArray<{
  readonly position: string;
  readonly at: (m: string) => string;
  readonly verdicts: VerdictsByPrefix;
}> = [
  // r12r4 probe 1: the `@` percent-encoded, so the user is left of the last `:`
  {
    position: 'authority_user_percent_at',
    at: (m) => `https://${m}:x-oauth-basic%40github.com/org/x.git?ref=main`,
    verdicts: GIT_BRANCH,
  },
  // r12r4 probe 2: the `@` written as an HCL escape; Terraform evaluates it to `@`
  {
    position: 'authority_user_hcl_at',
    at: (m) => `https://${m}:x-oauth-basic${HCL_AT}github.com/org/x.git?ref=main`,
    verdicts: GIT_BRANCH,
  },
  {
    position: 'authority_user_hcl_long_at',
    at: (m) => `https://${m}:x-oauth-basic${HCL_AT_LONG}github.com/org/x.git?ref=main`,
    verdicts: GIT_BRANCH,
  },
  {
    position: 'authority_user_hcl_colon_at',
    at: (m) => `https://${m}${HCL_COLON}x-oauth-basic${HCL_AT}github.com/org/x.git?ref=main`,
    verdicts: GIT_BRANCH,
  },
  {
    position: 'authority_user_percent_colon_at',
    at: (m) => `https://${m}%3Ax-oauth-basic%40github.com/org/x.git?ref=main`,
    verdicts: GIT_BRANCH,
  },
  // r12r4 probe 17: user:password and no host; the left half is a hostname, the right no port
  { position: 'authority_port_not_digits', at: (m) => `https://${m}:pw/m.zip`, verdicts: PLAIN },
  { position: 'authority_port_empty', at: (m) => `https://${m}:/m.zip`, verdicts: PLAIN },
  {
    position: 'authority_port_percent_at',
    at: (m) => `https://${m}:8443%40example.com/m.zip`,
    verdicts: PLAIN,
  },
  {
    position: 'authority_port_hcl_at',
    at: (m) => `https://${m}:8443${HCL_AT}example.com/m.zip`,
    verdicts: PLAIN,
  },
  // r12r4 probe 3: a scheme-less token user, the `@` an HCL escape; SEGMENT allows `_`
  {
    position: 'schemeless_user_hcl_at',
    at: (m) => `ghp_${m}:x${HCL_AT}github.com/org/x.git`,
    verdicts: GIT_UNPINNED,
  },
  {
    position: 'schemeless_user_hcl_long_at',
    at: (m) => `ghp_${m}:x${HCL_AT_LONG}github.com/org/x.git`,
    verdicts: GIT_UNPINNED,
  },
  {
    position: 'schemeless_user_percent_at',
    at: (m) => `ghp_${m}:x%40github.com/org/x.git`,
    verdicts: GIT_UNPINNED,
  },
  // a scheme-less head whose segment after `:` fails SEGMENT outright
  {
    position: 'schemeless_head_segment_fails',
    at: (m) => `${m}:x;y/org/x.git`,
    verdicts: GIT_UNPINNED,
  },
  // the scp form with its `@` encoded or escaped
  {
    position: 'schemeless_scp_percent_at',
    at: (m) => `${m}%40github.com:org/x.git?ref=main`,
    verdicts: GIT_BRANCH,
  },
  {
    position: 'schemeless_scp_hcl_at',
    at: (m) => `${m}${HCL_AT}github.com:org/x.git?ref=main`,
    verdicts: GIT_BRANCH,
  },
  // a `?` or `#` written as an HCL escape: after it, a query argument or a fragment
  {
    position: 'query_hcl_question',
    at: (m) => `${ARCHIVE}${HCL_QUESTION}token=${m}`,
    verdicts: PLAIN,
  },
  { position: 'fragment_hcl_hash', at: (m) => `${ARCHIVE}${HCL_HASH}${m}`, verdicts: PLAIN },
];

/**
 * The round-5 corpus: every AUTHORITY_POSITIONS entry under every forced prefix. Its markers are
 * drawn from index 300 on, clear of terraformSourceProbes (from 0) and reviewerProbes (from 500).
 * The verdict is the one terraform-pins.ts gives the value Terraform evaluates; for these
 * sources it equals the verdict on the written text, so decoding moves none of them.
 */
export function authorityProbes(): TerraformSourceProbe[] {
  const probes: TerraformSourceProbe[] = [];
  for (const { position, at, verdicts } of AUTHORITY_POSITIONS) {
    FORCED_PREFIXES.forEach((prefix, column) => {
      const marker = plantedMarker(300 + probes.length);
      const verdict = verdicts[column];
      if (verdict === undefined) throw new RangeError(`${position} has no verdict for ${prefix}`);
      probes.push({
        name: `${prefixLabel(prefix)}_${position}`,
        source: `${prefix}${at(marker)}`,
        marker,
        verdict,
      });
    });
  }
  return probes;
}

/** `probes` as one `.tf` file, one module per line (line `i + 1` holds probe `i`). */
export function probesAsTerraform(probes: readonly TerraformSourceProbe[]): string {
  return `${probes.map((probe) => `module "${probe.name}" { source = "${probe.source}" }`).join('\n')}\n`;
}
