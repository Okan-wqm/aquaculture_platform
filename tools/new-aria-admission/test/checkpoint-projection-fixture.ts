import { createHash } from 'node:crypto';

const artifact = Buffer.from(
  '{"contract_id":"new-aria-test-projection-v1","schema_version":"1.0.0"}\n',
);
const sha256 = createHash('sha256').update(artifact).digest('hex');

export function checkpointProjectionCommitFields(): {
  readonly projection_artifact_bytes: Buffer;
  readonly projection_sha256: string;
} {
  return {
    projection_artifact_bytes: Buffer.from(artifact),
    projection_sha256: sha256,
  };
}

export function checkpointProjectionTipFields(): {
  readonly projection_artifact_base64: string;
  readonly projection_sha256: string;
} {
  return {
    projection_artifact_base64: artifact.toString('base64'),
    projection_sha256: sha256,
  };
}
