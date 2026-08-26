import {
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
} from '@aws-sdk/client-s3';

import { telemetryArchiveBucketName } from './telemetry-archive-coordinator.service';
import type { TelemetryArchiveS3Port } from './s3-telemetry-archive-object-store.service';

export interface TelemetryArchiveStoragePrincipals {
  readonly exporter: string;
  readonly verifier: string;
  readonly restore: string;
  readonly erasure: string;
}

export class TelemetryArchiveBucketProvisionerService {
  constructor(
    private readonly client: TelemetryArchiveS3Port,
    private readonly principals: TelemetryArchiveStoragePrincipals,
  ) {
    const distinct = new Set(Object.values(principals));
    if (distinct.size !== 4) {
      throw new Error('Telemetry archive storage principals must be four distinct identities');
    }
    for (const principal of distinct) {
      if (!/^arn:aws:iam::(?:[0-9]{12}|[a-z0-9-]+):user\/[A-Za-z0-9+=,.@_-]+$/.test(principal)) {
        throw new Error('Telemetry archive storage principal must be an exact IAM user ARN');
      }
    }
  }

  async provisionTenant(tenantId: string): Promise<string> {
    const bucket = telemetryArchiveBucketName(tenantId);
    await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
    await this.client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    await this.client.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify(this.buildPolicy(bucket)),
      }),
    );
    return bucket;
  }

  private buildPolicy(bucket: string): Record<string, unknown> {
    const bucketArn = `arn:aws:s3:::${bucket}`;
    return {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'ExporterWriteOnly',
          Effect: 'Allow',
          Principal: { AWS: this.principals.exporter },
          Action: ['s3:PutObject'],
          Resource: `${bucketArn}/*`,
        },
        {
          Sid: 'VerifierReadOnly',
          Effect: 'Allow',
          Principal: { AWS: this.principals.verifier },
          Action: ['s3:GetObject', 's3:GetObjectVersion'],
          Resource: `${bucketArn}/*`,
        },
        {
          Sid: 'RestoreReadOnly',
          Effect: 'Allow',
          Principal: { AWS: this.principals.restore },
          Action: ['s3:GetObject', 's3:GetObjectVersion'],
          Resource: `${bucketArn}/*`,
        },
        {
          Sid: 'ErasureObjectVersions',
          Effect: 'Allow',
          Principal: { AWS: this.principals.erasure },
          Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
          Resource: `${bucketArn}/*`,
        },
        {
          Sid: 'ErasureBucket',
          Effect: 'Allow',
          Principal: { AWS: this.principals.erasure },
          Action: ['s3:ListBucketVersions', 's3:DeleteBucket'],
          Resource: bucketArn,
        },
        {
          Sid: 'DenyInsecureTransport',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [bucketArn, `${bucketArn}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ],
    };
  }
}
