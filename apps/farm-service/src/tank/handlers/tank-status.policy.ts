import { BadRequestException } from '@nestjs/common';

import { Tank, TankStatus } from '../entities/tank.entity';

export function getAllowedTankStatusTransitions(status: TankStatus): TankStatus[] {
  const transitions: Record<TankStatus, TankStatus[]> = {
    [TankStatus.INACTIVE]: [TankStatus.PREPARING],
    [TankStatus.PREPARING]: [TankStatus.ACTIVE, TankStatus.INACTIVE],
    [TankStatus.ACTIVE]: [
      TankStatus.HARVESTING,
      TankStatus.MAINTENANCE,
      TankStatus.QUARANTINE,
      TankStatus.FALLOW,
    ],
    [TankStatus.HARVESTING]: [TankStatus.CLEANING],
    [TankStatus.CLEANING]: [TankStatus.PREPARING, TankStatus.MAINTENANCE, TankStatus.FALLOW],
    [TankStatus.MAINTENANCE]: [TankStatus.PREPARING, TankStatus.INACTIVE],
    [TankStatus.FALLOW]: [TankStatus.PREPARING],
    [TankStatus.QUARANTINE]: [TankStatus.ACTIVE, TankStatus.CLEANING],
  };

  return transitions[status] || [];
}

export function assertTankStatusTransition(tank: Tank, newStatus: TankStatus): void {
  if (!tank.canTransitionTo(newStatus)) {
    throw new BadRequestException(
      `Invalid status transition from "${tank.status}" to "${newStatus}". ` +
        `Allowed transitions: ${getAllowedTankStatusTransitions(tank.status).join(', ')}`,
    );
  }

  switch (newStatus) {
    case TankStatus.HARVESTING:
      if (Number(tank.currentBiomass || 0) <= 0) {
        throw new BadRequestException('Cannot start harvesting: tank has no biomass');
      }
      break;
    case TankStatus.INACTIVE:
      if (Number(tank.currentBiomass || 0) > 0) {
        throw new BadRequestException('Cannot deactivate tank with active biomass');
      }
      break;
  }
}
