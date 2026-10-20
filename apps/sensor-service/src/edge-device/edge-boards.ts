import artifactNamingContract from '../../../../contracts/suderra-edge/v1/artifact-naming.json';
import boardsContract from '../../../../contracts/suderra-edge/v1/boards.json';

import { type Arch, BOARD_PROFILES, type BoardProfile } from './edge-contract';

/**
 * The board vocabulary and artifact naming the cloud provisions against,
 * read from the contract itself (ADR-048 DEC-8.4, DEC-8.5,
 * `contracts/suderra-edge/v1/{boards,artifact-naming}.json`) — the release
 * workflow, the OS root installer and the agent read the same files, so a
 * board or name changes in one place.
 */

export interface BoardRow {
  readonly boardProfile: BoardProfile;
  readonly arch: Arch;
  readonly agentProfile: 'suderra-os';
  readonly cargoFeatures: readonly string[];
  readonly cloudProvisioningAllowed: boolean;
  readonly cloudDeviceModels: readonly string[];
}

function isBoardProfile(value: string): value is BoardProfile {
  return (BOARD_PROFILES as readonly string[]).includes(value);
}

const ROWS: ReadonlyMap<BoardProfile, BoardRow> = new Map(
  boardsContract.boards.map((row): [BoardProfile, BoardRow] => {
    const profile = row.board_profile;
    if (!isBoardProfile(profile) || (row.arch !== 'aarch64' && row.arch !== 'x86_64')) {
      throw new Error(`boards.json row ${profile} is outside the cloud's board vocabulary`);
    }
    if (row.agent_profile !== 'suderra-os') {
      throw new Error(`boards.json row ${profile} has agent_profile ${row.agent_profile}`);
    }
    return [
      profile,
      {
        boardProfile: profile,
        arch: row.arch,
        agentProfile: 'suderra-os',
        cargoFeatures: [...row.cargo_features].sort(),
        cloudProvisioningAllowed: row.cloud_provisioning.allowed,
        cloudDeviceModels: row.cloud_device_models,
      },
    ];
  }),
);

/** The contract row of a board, or null for a board outside the contract. */
export function boardRow(profile: string): BoardRow | null {
  return isBoardProfile(profile) ? (ROWS.get(profile) ?? null) : null;
}

const NAMING = artifactNamingContract.suderra_os_channel;

/** suderra-agent-os-{version}-{board_profile}-{arch}.tar.gz */
export function releaseArtifactName(version: string, board: BoardRow): string {
  return NAMING.artifact
    .replace('{version}', version)
    .replace('{board_profile}', board.boardProfile)
    .replace('{arch}', board.arch);
}

/** {artifact}.release.dsse.json — the DSSE release statement beside the artifact. */
export function releaseStatementName(artifact: string): string {
  return NAMING.statement.replace('{artifact}', artifact);
}

export const RELEASE_BINARY_NAME: string = NAMING.binary_name;
export const RELEASE_ARTIFACT_FORMAT: string = NAMING.format;
