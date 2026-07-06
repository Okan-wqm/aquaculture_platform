/**
 * Pre-submit validation of Mattilsynet payloads against the official JSON
 * Schemas (schemas/official/*.json).
 *
 * The regulator's schema is the wire-format contract: an invalid payload must
 * never reach the network. validate() is the ONLY producer of
 * ValidatedPayload<T> (the brand MattilsynetApiService requires), so skipping
 * this service is a compile-time error, not a runtime hope.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ErrorObject } from 'ajv';

import { MattilsynetBasePayload } from '../mattilsynet-api.service';
import { getOfficialSchemaValidator, MattilsynetRestReportType } from '../schemas/schema-registry';
import { ValidatedPayload } from '../schemas/validated-payload';

export interface SchemaValideringsfeil {
  felt: string;
  melding: string;
}

export class MattilsynetSchemaValidationError extends Error {
  constructor(
    readonly reportType: MattilsynetRestReportType,
    readonly valideringsfeil: SchemaValideringsfeil[],
  ) {
    super(
      `Payload failed official Mattilsynet schema validation (${reportType}): ` +
        valideringsfeil.map((v) => `${v.felt}: ${v.melding}`).join('; '),
    );
    this.name = 'MattilsynetSchemaValidationError';
  }
}

@Injectable()
export class MattilsynetSchemaValidatorService {
  private readonly logger = new Logger(MattilsynetSchemaValidatorService.name);

  /**
   * Validate a payload against the official schema for its report type.
   * Returns the branded payload on success; throws
   * MattilsynetSchemaValidationError carrying field-level valideringsfeil on
   * failure.
   */
  validate<T extends MattilsynetBasePayload>(
    reportType: MattilsynetRestReportType,
    payload: T,
  ): ValidatedPayload<T> {
    const validator = getOfficialSchemaValidator(reportType);
    if (validator(payload)) {
      // The single brand-applying assertion (see validated-payload.ts).
      return payload as ValidatedPayload<T>;
    }

    const feil = (validator.errors ?? []).map((e) => this.toValideringsfeil(e));
    this.logger.warn(
      `Rejected ${reportType} payload before submission: ${feil.length} schema violation(s).`,
    );
    throw new MattilsynetSchemaValidationError(reportType, feil);
  }

  private toValideringsfeil(error: ErrorObject): SchemaValideringsfeil {
    const basePath = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
    if (error.keyword === 'required') {
      const missing = (error.params as { missingProperty: string }).missingProperty;
      return {
        felt: basePath ? `${basePath}.${missing}` : missing,
        melding: 'is required by the official Mattilsynet schema',
      };
    }
    if (error.keyword === 'additionalProperties') {
      const extra = (error.params as { additionalProperty: string }).additionalProperty;
      return {
        felt: basePath ? `${basePath}.${extra}` : extra,
        melding: 'is not part of the official Mattilsynet schema',
      };
    }
    return {
      felt: basePath || '(root)',
      melding: error.message ?? `violates ${error.keyword}`,
    };
  }
}
