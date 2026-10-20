import artifactNamingContract from '../../../../contracts/suderra-edge/v1/artifact-naming.json';
import boardsContract from '../../../../contracts/suderra-edge/v1/boards.json';

import {
  type Arch,
  BINDING_METHODS,
  type BindingMethod,
  BOARD_PROFILES,
  type BoardProfile,
} from './edge-contract';

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
  /** The one binding method a device of this board presents (DEC-3.6). */
  readonly deviceBindingMethod: BindingMethod;
  readonly cloudProvisioningAllowed: boolean;
  /** The cloud DeviceModel values provisioned as this board. */
  readonly cloudDeviceModels: readonly string[];
}

function isBoardProfile(value: string): value is BoardProfile {
  return (BOARD_PROFILES as readonly string[]).includes(value);
}

function isBindingMethod(value: string): value is BindingMethod {
  return (BINDING_METHODS as readonly string[]).includes(value);
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
    if (!isBindingMethod(row.device_binding_method)) {
      throw new Error(`boards.json row ${profile} binds by ${row.device_binding_method}`);
    }
    return [
      profile,
      {
        boardProfile: profile,
        arch: row.arch,
        agentProfile: 'suderra-os',
        cargoFeatures: [...row.cargo_features].sort(),
        deviceBindingMethod: row.device_binding_method,
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

/**
 * The board a cloud DeviceModel is provisioned as: the boards.json row whose
 * `cloud_device_models` names it. Null for a model the contract leaves on the
 * generic-Linux channel or maps only to a pending family. A model named by
 * two rows would make the mapping ambiguous; that is refused at load.
 */
export function boardForDeviceModel(deviceModel: string): BoardRow | null {
  return BOARD_BY_DEVICE_MODEL.get(deviceModel) ?? null;
}

const BOARD_BY_DEVICE_MODEL: ReadonlyMap<string, BoardRow> = (() => {
  const byModel = new Map<string, BoardRow>();
  for (const row of ROWS.values()) {
    for (const model of row.cloudDeviceModels) {
      const taken = byModel.get(model);
      if (taken !== undefined) {
        throw new Error(
          `boards.json maps DeviceModel ${model} to ${taken.boardProfile} and ${row.boardProfile}`,
        );
      }
      byModel.set(model, row);
    }
  }
  return byModel;
})();

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
