import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FARM_SRC_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(FARM_SRC_ROOT, '../../..');

function readFarmSource(relativePath: string): string {
  return readFileSync(join(FARM_SRC_ROOT, relativePath), 'utf8');
}

function collectRuntimeTypeScript(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (
      entry.isDirectory() &&
      entry.name !== '__tests__' &&
      entry.name !== 'migrations' &&
      !entry.name.startsWith('.')
    ) {
      files.push(...collectRuntimeTypeScript(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolutePath);
    }
  }
  return files;
}

describe('frozen legacy weather settings contract', () => {
  it('keeps persistence metadata without exposing a GraphQL type', () => {
    const entity = readFarmSource('weather/entities/weather-settings.entity.ts');
    const schema = readFileSync(join(REPO_ROOT, 'apps/farm-service/schema.graphql'), 'utf8');

    expect(entity).toContain("@Entity('weather_settings')");
    expect(entity).not.toContain("from '@nestjs/graphql'");
    expect(entity).not.toMatch(/@(ObjectType|Field|InputType|ArgsType)\b/);
    expect(schema).not.toMatch(/\b(type|input)\s+WeatherSettings\b/);
    expect(schema).not.toMatch(/\b(weatherSettings|updateWeatherSettings|syncWeatherData)\b/);
  });

  it('has no runtime reader, writer, resolver, or retired provider service', () => {
    const retiredPaths = [
      'weather/weather.resolver.ts',
      'weather/services/open-meteo.service.ts',
      'weather/services/weather-cron.service.ts',
      'weather/services/weather-sync.service.ts',
    ];
    for (const relativePath of retiredPaths) {
      expect(existsSync(join(FARM_SRC_ROOT, relativePath))).toBe(false);
    }

    const allowedReferences = new Set([
      join(FARM_SRC_ROOT, 'weather/entities/weather-settings.entity.ts'),
      join(FARM_SRC_ROOT, 'weather/weather.module.ts'),
    ]);
    const runtimeReferences = collectRuntimeTypeScript(FARM_SRC_ROOT)
      .filter((file) => !allowedReferences.has(file))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /\bWeatherSettings\b|\bweather_settings\b/.test(source);
      })
      .map((file) => file.slice(FARM_SRC_ROOT.length + 1));

    expect(runtimeReferences).toEqual([]);
  });

  it('retains schema-template registration without creating a second data path', () => {
    const weatherModule = readFarmSource('weather/weather.module.ts');
    const schemaManager = readFileSync(
      join(REPO_ROOT, 'libs/backend-common/src/database/schema-manager.service.ts'),
      'utf8',
    );

    expect(weatherModule).toContain('WeatherSettings');
    expect(weatherModule).toContain('TypeOrmModule.forFeature([');
    expect(schemaManager).toContain("'weather_settings'");
  });
});
