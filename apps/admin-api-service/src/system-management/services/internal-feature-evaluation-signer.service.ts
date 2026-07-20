import {
  resolveFeatureEvaluationKeyring,
  signFeatureEvaluationSnapshot,
  type FeatureEvaluationSnapshot,
  type FeatureEvaluationValue,
} from '@aquaculture/backend-common/feature-toggle';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InternalFeatureEvaluationSigner {
  constructor(private readonly configService: ConfigService) {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      // Resolve during provider construction so malformed/weak/missing signing
      // material aborts Nest bootstrap, rather than failing the first request.
      resolveFeatureEvaluationKeyring({
        rawKeyring: this.configService.get<string>('SERVICE_IDENTITY_KEYRING'),
        configuredActiveKeyId: this.configService.get<string>('SERVICE_IDENTITY_SIGNING_KID'),
        developmentSecret: undefined,
        isProduction: true,
      });
    }
  }

  sign(input: {
    readonly audience: string;
    readonly tenantId: string;
    readonly evaluations: readonly FeatureEvaluationValue[];
  }): FeatureEvaluationSnapshot {
    const { keyring, activeKeyId } = resolveFeatureEvaluationKeyring({
      rawKeyring: this.configService.get<string>('SERVICE_IDENTITY_KEYRING'),
      configuredActiveKeyId: this.configService.get<string>('SERVICE_IDENTITY_SIGNING_KID'),
      developmentSecret: this.configService.get<string>('SERVICE_IDENTITY_SIGNING_SECRET'),
      isProduction: this.configService.get<string>('NODE_ENV') === 'production',
    });

    if (!activeKeyId) {
      throw new Error('SERVICE_IDENTITY_SIGNING_KID is required for feature evaluation signing');
    }

    return signFeatureEvaluationSnapshot({
      ...input,
      keyring,
      activeKeyId,
      lifetimeMs: 15_000,
    });
  }
}
