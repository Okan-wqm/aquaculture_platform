import type { TenantRequest } from '@aquaculture/backend-common/types';
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response as ExpressResponse } from 'express';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

import { MarineAoiAnalysisDto, MarinePointQueryDto } from './dto/marine-requests.dto';
import { MarineCachePolicy, type MarineCacheSubject } from './marine-cache.policy';
import { MarineDataService } from './marine-data.service';

type MarineTenantRequest = TenantRequest & Request;

@Controller('api/internal/marine')
@UseGuards(JwtAuthGuard)
export class MarineDataController {
  constructor(
    private readonly marineDataService: MarineDataService,
    private readonly marineCachePolicy: MarineCachePolicy,
  ) {}

  @Get('layers')
  getLayers(@Res({ passthrough: true }) res: ExpressResponse) {
    this.applyCacheHeaders(res, 'layers');
    return this.marineDataService.getLayers();
  }

  @Get('layers/:layerId/availability')
  getAvailability(
    @Param('layerId') layerId: string,
    @Query('date') date: string | undefined,
    @Query('depth') depth: string | undefined,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    this.applyCacheHeaders(res, 'availability');
    return this.marineDataService.getAvailability({
      layerId,
      date,
      depth,
    });
  }

  @Get('tiles/:layerId/:z/:x/:y.png')
  async getTile(
    @Param('layerId') layerId: string,
    @Param('z') z: string,
    @Param('x') x: string,
    @Param('y') y: string,
    @Query('date') date: string | undefined,
    @Query('depth') depth: string | undefined,
    @Req() req: MarineTenantRequest,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const tenantId = this.extractTenantId(req);
    const tile = await this.marineDataService.getTile({
      tenantId,
      layerId,
      tileMatrix: z,
      tileCol: x,
      tileRow: y,
      date,
      depth,
    });
    res.status(tile.status);
    res.setHeader('Content-Type', tile.contentType);
    this.applyCacheHeaders(res, 'tile', tile.status);
    res.send(tile.body);
  }

  @Post('point-query')
  async getPoint(
    @Body() body: MarinePointQueryDto,
    @Req() req: MarineTenantRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const tenantId = this.extractTenantId(req);
    if (!body.layerId || body.lat === undefined || body.lng === undefined) {
      throw new BadRequestException('layerId, lat, and lng are required');
    }
    this.applyCacheHeaders(res, 'point-query');
    return this.marineDataService.getPoint({
      tenantId,
      layerId: body.layerId,
      lat: String(body.lat),
      lng: String(body.lng),
      date: body.date,
      depth: body.depth === undefined ? undefined : String(body.depth),
      zoom: body.zoom === undefined ? undefined : String(body.zoom),
    });
  }

  @Post('aoi-analysis')
  async analyzeAoi(
    @Body() body: MarineAoiAnalysisDto,
    @Req() req: MarineTenantRequest,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const tenantId = this.extractTenantId(req);
    if (!body.layerId) {
      throw new BadRequestException('layerId is required');
    }
    const tile = await this.marineDataService.analyzeAoi({
      tenantId,
      layerId: body.layerId,
      bbox: Array.isArray(body.bbox) ? body.bbox.join(',') : body.bbox,
      fromDate: body.fromDate,
      toDate: body.toDate,
      width: body.width === undefined ? undefined : String(body.width),
      height: body.height === undefined ? undefined : String(body.height),
    });
    res.status(tile.status);
    res.setHeader('Content-Type', tile.contentType);
    this.applyCacheHeaders(res, 'aoi-analysis', tile.status);
    res.send(tile.body);
  }

  private applyCacheHeaders(
    res: ExpressResponse,
    subject: MarineCacheSubject,
    status?: number,
  ): void {
    const headers = this.marineCachePolicy.headersFor(subject, status);
    res.setHeader('Cache-Control', headers.cacheControl);
    res.setHeader('Vary', headers.vary.join(', '));
  }

  private extractTenantId(req: MarineTenantRequest): string {
    const tenantId = req.verifiedUserAssertion?.effectiveTenantId ?? req.user?.tenantId ?? req.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID not found in request context');
    }
    return tenantId;
  }
}
