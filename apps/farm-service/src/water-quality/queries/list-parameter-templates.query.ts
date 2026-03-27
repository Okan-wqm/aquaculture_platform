/**
 * ListParameterTemplatesQuery
 *
 * Statik parametre sablonlarini listeler.
 * Sablonlar tenant-bagimsiz sabitlerdir.
 *
 * @module WaterQuality/Queries
 */
import { IQuery } from '@platform/cqrs';

export class ListParameterTemplatesQuery implements IQuery {
  readonly queryName = 'ListParameterTemplatesQuery';
}
