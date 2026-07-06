/**
 * Treatment Application Service — writes the per-application treatment facts
 * the lakselus report's behandlinger arrays assemble from.
 *
 * Fail-closed at the WRITE boundary: method and virkestoff values are
 * validated against the official Mattilsynet value lists (the same const
 * arrays the wire payload types derive from), so a row that reaches the
 * assembler is emittable verbatim. A MEDICINAL application must name its
 * virkestoff; ANNET_VIRKESTOFF / ANNEN_BEHANDLING must carry a description
 * (the official schema requires the free text exactly then).
 *
 * @module FishHealth
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';

import {
  IKKE_MEDIKAMENTELL_TYPES,
  MEDIKAMENTELL_TYPES,
  MENGDE_ENHETER,
  STYRKE_ENHETER,
  VIRKESTOFF_TYPES,
} from '../../regulatory/mattilsynet-api.service';
import { TreatmentApplication, TreatmentCategory } from '../entities/treatment-application.entity';
import { RecordTreatmentApplicationInput } from '../dto/field-capture.inputs';

function isOneOf(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

@Injectable()
export class TreatmentApplicationService {
  private readonly logger = new Logger(TreatmentApplicationService.name);

  constructor(private readonly dataSource: DataSource) {}

  async record(
    tenantId: string,
    input: RecordTreatmentApplicationInput,
    userId: string,
  ): Promise<TreatmentApplication> {
    this.assertOfficialValues(input);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repo = tenantManagerRepo(queryRunner.manager, TreatmentApplication, tenantId);
      const saved = await repo.save(
        repo.create({
          tenantId,
          siteId: input.siteId,
          tankId: input.tankId,
          batchId: input.batchId,
          healthEventId: input.healthEventId,
          category: input.category,
          method: input.method,
          chemicalId: input.chemicalId,
          virkestoffType: input.virkestoffType,
          styrkeVerdi: input.styrkeVerdi,
          styrkeEnhet: input.styrkeEnhet,
          mengdeVerdi: input.mengdeVerdi,
          mengdeEnhet: input.mengdeEnhet,
          wholeSite: input.wholeSite ?? false,
          pensCount: input.pensCount,
          appliedAt: new Date(input.appliedAt),
          completedAt: input.completedAt ? new Date(input.completedAt) : undefined,
          veterinarianWorkerId: input.veterinarianWorkerId,
          externalVetName: input.externalVetName,
          beskrivelse: input.beskrivelse,
          recordedBy: userId,
        }),
      );
      this.logger.log(
        `Recorded ${input.category} treatment ${saved.id} (${input.method}) for site ${input.siteId}`,
      );
      return saved;
    });
  }

  /**
   * Reject values the official wire contract cannot carry. Doing this at
   * write time (tier 3: detectable before persistence) keeps every stored
   * row directly emittable by the lakselus assembler.
   */
  private assertOfficialValues(input: RecordTreatmentApplicationInput): void {
    if (input.category === TreatmentCategory.MEDICINAL) {
      if (!isOneOf(MEDIKAMENTELL_TYPES, input.method)) {
        throw new BadRequestException(
          `Medicinal method must be one of ${MEDIKAMENTELL_TYPES.join(', ')} (got '${input.method}')`,
        );
      }
      if (!input.virkestoffType) {
        throw new BadRequestException(
          'A medicinal treatment must name its virkestoff (official value; use ANNET_VIRKESTOFF + beskrivelse for unlisted substances)',
        );
      }
      if (!isOneOf(VIRKESTOFF_TYPES, input.virkestoffType)) {
        throw new BadRequestException(
          `virkestoffType must be one of ${VIRKESTOFF_TYPES.join(', ')} (got '${input.virkestoffType}')`,
        );
      }
      if (input.virkestoffType === 'ANNET_VIRKESTOFF' && !input.beskrivelse) {
        throw new BadRequestException('ANNET_VIRKESTOFF requires beskrivelse naming the substance');
      }
    } else {
      if (!isOneOf(IKKE_MEDIKAMENTELL_TYPES, input.method)) {
        throw new BadRequestException(
          `Non-medicinal method must be one of ${IKKE_MEDIKAMENTELL_TYPES.join(', ')} (got '${input.method}')`,
        );
      }
      if (input.virkestoffType) {
        throw new BadRequestException('A non-medicinal treatment cannot carry a virkestoff');
      }
    }

    if (input.method === 'ANNEN_BEHANDLING' && !input.beskrivelse) {
      throw new BadRequestException('ANNEN_BEHANDLING requires beskrivelse describing the method');
    }
    if (input.styrkeEnhet && !isOneOf(STYRKE_ENHETER, input.styrkeEnhet)) {
      throw new BadRequestException(
        `styrkeEnhet must be one of ${STYRKE_ENHETER.join(', ')} (got '${input.styrkeEnhet}')`,
      );
    }
    if (input.mengdeEnhet && !isOneOf(MENGDE_ENHETER, input.mengdeEnhet)) {
      throw new BadRequestException(
        `mengdeEnhet must be one of ${MENGDE_ENHETER.join(', ')} (got '${input.mengdeEnhet}')`,
      );
    }
    if ((input.styrkeVerdi === undefined) !== (input.styrkeEnhet === undefined)) {
      throw new BadRequestException('styrkeVerdi and styrkeEnhet must be provided together');
    }
    if ((input.mengdeVerdi === undefined) !== (input.mengdeEnhet === undefined)) {
      throw new BadRequestException('mengdeVerdi and mengdeEnhet must be provided together');
    }
  }
}
