/**
 * Save Feeder Calibrations Command
 * Upserts all calibrations for a given equipment
 */
import { SaveFeederCalibrationsInput } from '../dto/feeder-calibration.input';

export class SaveFeederCalibrationsCommand {
  constructor(
    public readonly input: SaveFeederCalibrationsInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
