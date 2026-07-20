import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  CreateFeatureToggleDto,
  UpdateFeatureToggleDto,
} from '../controllers/global-settings.controller';
import {
  FeatureToggleScope,
  FeatureToggleStatus,
} from '../entities/feature-toggle.entity';

/**
 * APA-251: FeatureTogglesPage's primary action (toggleFeature) now maps to the
 * canonical PUT /system/settings/feature-toggles/:id carrying the 4-state
 * status enum (the phantom POST :id/toggle route it used before 404'd every
 * click). The Create/Update DTOs were tightened from @IsString to @IsEnum so an
 * out-of-vocabulary status/scope is rejected at the ValidationPipe boundary
 * (400) instead of reaching the service's Object.assign. These validate() tests
 * pin that boundary without bootstrapping a Nest app.
 */
describe('Feature-toggle DTOs — enum-bound status/scope (APA-251)', () => {
  it('accepts the enabled/disabled status toggleFeature sends', async () => {
    for (const status of ['enabled', 'disabled'] as FeatureToggleStatus[]) {
      const dto = plainToInstance(UpdateFeatureToggleDto, { status });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('accepts every real FeatureToggleStatus enum value on update', async () => {
    for (const status of Object.values(FeatureToggleStatus)) {
      const dto = plainToInstance(UpdateFeatureToggleDto, { status });
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it('rejects an out-of-vocabulary status on update (400 at the boundary)', async () => {
    const dto = plainToInstance(UpdateFeatureToggleDto, { status: 'bogus' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('status');
    expect(errors[0]?.constraints).toHaveProperty('isEnum');
  });

  it('rejects an out-of-vocabulary scope on create', async () => {
    const dto = plainToInstance(CreateFeatureToggleDto, {
      key: 'flag.x',
      name: 'Flag X',
      scope: 'galaxy',
      status: FeatureToggleStatus.ENABLED,
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('scope');
  });

  it('accepts a well-formed create with real enum values', async () => {
    const dto = plainToInstance(CreateFeatureToggleDto, {
      key: 'flag.x',
      name: 'Flag X',
      scope: FeatureToggleScope.GLOBAL,
      status: FeatureToggleStatus.DISABLED,
    });
    expect(await validate(dto)).toHaveLength(0);
  });
});
