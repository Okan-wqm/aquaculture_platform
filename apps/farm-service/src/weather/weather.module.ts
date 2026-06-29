/**
 * Weather Module
 * Open-Meteo hava durumu ve deniz verisi entegrasyonu
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WeatherObservation } from './entities/weather-observation.entity';
import { MarineObservation } from './entities/marine-observation.entity';
import { WeatherSettings } from './entities/weather-settings.entity';
import { Site } from '../site/entities/site.entity';
import { OpenMeteoService } from './services/open-meteo.service';
import { WeatherSyncService } from './services/weather-sync.service';
import { WeatherCronService } from './services/weather-cron.service';
import { WeatherResolver } from './weather.resolver';
import { GetWeatherSettingsHandler } from './handlers/get-weather-settings.handler';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WeatherObservation,
      MarineObservation,
      WeatherSettings,
      Site,
    ]),
  ],
  providers: [
    OpenMeteoService,
    WeatherSyncService,
    WeatherCronService,
    WeatherResolver,
    GetWeatherSettingsHandler,
  ],
  exports: [
    WeatherSyncService,
    OpenMeteoService,
  ],
})
export class WeatherModule {}
