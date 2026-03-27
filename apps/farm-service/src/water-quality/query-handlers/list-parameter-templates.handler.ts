/**
 * ListParameterTemplatesHandler
 *
 * ListParameterTemplatesQuery'yi isler ve statik parametre
 * sablon metadatasini doner. Veritabani erisimi yoktur.
 *
 * @module WaterQuality/QueryHandlers
 */
import { Injectable, Logger } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { ListParameterTemplatesQuery } from '../queries/list-parameter-templates.query';
import { PARAMETER_TEMPLATES } from '../data/parameter-templates.data';

/**
 * Summary metadata for a parameter template
 */
export interface ParameterTemplateSummary {
  templateId: string;
  name: string;
  description: string;
  species: string[];
  parameterCount: number;
  parameterCodes: string[];
}

@Injectable()
@QueryHandler(ListParameterTemplatesQuery)
export class ListParameterTemplatesHandler
  implements IQueryHandler<ListParameterTemplatesQuery, ParameterTemplateSummary[]>
{
  private readonly logger = new Logger(ListParameterTemplatesHandler.name);

  async execute(_query: ListParameterTemplatesQuery): Promise<ParameterTemplateSummary[]> {
    this.logger.debug('Listing parameter templates');

    return PARAMETER_TEMPLATES.map((template) => ({
      templateId: template.templateId,
      name: template.name,
      description: template.description,
      species: template.species,
      parameterCount: template.parameters.length,
      parameterCodes: template.parameters.map((p) => p.code),
    }));
  }
}
