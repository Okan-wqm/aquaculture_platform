import { IsIn, IsOptional } from 'class-validator';

/**
 * Body for `POST /messaging/tenants/:id/export`.
 *
 * A class (not a TS interface) so the global ValidationPipe engages and an
 * unknown `format` is rejected with a 400 at the edge (APA-179). Defaults to
 * `'json'` in the controller when omitted.
 */
export class TriggerExportDto {
  @IsOptional()
  @IsIn(['csv', 'json'])
  format?: 'csv' | 'json';
}
