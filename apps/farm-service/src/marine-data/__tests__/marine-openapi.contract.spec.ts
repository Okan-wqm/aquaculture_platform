import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { parse } from 'yaml';

import {
  RETIRED_SENTINEL_CONTROLLER_PATH,
  RETIRED_SENTINEL_PREFIX_EXCLUSIONS,
  SentinelHubProxyController,
} from '../../sentinel-hub/sentinel-hub-proxy.controller';
import { EnvironmentLayerCapability } from '../../weather/entities/environment-observation.types';
import { CDSE_MAX_IMAGE_BYTES } from '../../weather/services/cdse-sentinel.provider';
import {
  FARM_INTERNAL_MARINE_CONTROLLER_PATH,
  FARM_INTERNAL_MARINE_PREFIX_EXCLUSIONS,
  MarineDataController,
} from '../marine-data.controller';
import {
  MARINE_RENDER_DEFAULT_DIMENSION,
  MARINE_RENDER_LAYER_ID_MAX_LENGTH,
  MARINE_RENDER_MAX_DIMENSION,
  MARINE_RENDER_MIN_DIMENSION,
  MARINE_RENDER_SCENE_ID_MAX_LENGTH,
} from '../marine-data.dto';
import { SENTINEL_LAYER_CATALOG } from '../marine-layer-catalog';

const OPENAPI_PATH = resolve(process.cwd(), 'docs/api/openapi/farm-service.yaml');

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function pathMetadata(target: object): string | string[] {
  const value: unknown = Reflect.getMetadata(PATH_METADATA, target);
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value;
  }
  throw new Error('Controller route metadata is absent or malformed');
}

function methodMetadata(target: object): RequestMethod {
  const value: unknown = Reflect.getMetadata(METHOD_METADATA, target);
  if (typeof value !== 'number') {
    throw new Error('Controller method metadata is absent or malformed');
  }
  return value;
}

function openApiDocument(): Record<string, unknown> {
  const parsed: unknown = parse(readFileSync(OPENAPI_PATH, 'utf8'));
  return record(parsed, 'OpenAPI document');
}

function operation(
  document: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> {
  const paths = record(document['paths'], 'OpenAPI paths');
  const pathItem = record(paths[path], `OpenAPI path ${path}`);
  return record(pathItem[method], `OpenAPI operation ${method.toUpperCase()} ${path}`);
}

function responseCodes(operationDocument: Record<string, unknown>): string[] {
  return Object.keys(record(operationDocument['responses'], 'OpenAPI responses')).sort();
}

describe('farm marine OpenAPI contract', () => {
  it('keeps explicit internal controller paths outside the shared /api/v1 prefix', () => {
    expect(pathMetadata(MarineDataController)).toBe(FARM_INTERNAL_MARINE_CONTROLLER_PATH);
    expect(FARM_INTERNAL_MARINE_PREFIX_EXCLUSIONS).toEqual([
      FARM_INTERNAL_MARINE_CONTROLLER_PATH,
      `${FARM_INTERNAL_MARINE_CONTROLLER_PATH}/(.*)`,
    ]);
    expect(pathMetadata(SentinelHubProxyController)).toBe(RETIRED_SENTINEL_CONTROLLER_PATH);
    expect(RETIRED_SENTINEL_PREFIX_EXCLUSIONS).toEqual([
      RETIRED_SENTINEL_CONTROLLER_PATH,
      `${RETIRED_SENTINEL_CONTROLLER_PATH}/(.*)`,
    ]);
  });

  it('documents the reflected exact-scene render route and every terminal response', () => {
    const renderPath = pathMetadata(MarineDataController.prototype.render);
    expect(renderPath).toBe('sites/:siteId/render');
    expect(methodMetadata(MarineDataController.prototype.render)).toBe(RequestMethod.POST);

    const apiPath = `/${FARM_INTERNAL_MARINE_CONTROLLER_PATH}/${String(renderPath).replace(
      ':siteId',
      '{siteId}',
    )}`;
    const renderOperation = operation(openApiDocument(), apiPath, 'post');

    expect(responseCodes(renderOperation)).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '502',
      '503',
    ]);
    const success = record(
      record(renderOperation['responses'], 'render responses')['200'],
      'render success response',
    );
    expect(success['x-response-max-bytes']).toBe(CDSE_MAX_IMAGE_BYTES);
    const headers = record(success['headers'], 'render response headers');
    expect(Object.keys(headers).sort()).toEqual([
      'Cache-Control',
      'Content-Length',
      'Vary',
      'X-Environment-Scene-Id',
      'X-Environment-Valid-At',
    ]);
  });

  it('derives documented render limits and imagery products from backend-owned contracts', () => {
    const document = openApiDocument();
    const components = record(document['components'], 'OpenAPI components');
    const schemas = record(components['schemas'], 'OpenAPI schemas');
    const request = record(schemas['MarineRenderRequest'], 'MarineRenderRequest');
    const properties = record(request['properties'], 'MarineRenderRequest properties');
    const layerId = record(properties['layerId'], 'MarineRenderRequest.layerId');
    const sceneId = record(properties['sceneId'], 'MarineRenderRequest.sceneId');
    const width = record(properties['width'], 'MarineRenderRequest.width');
    const height = record(properties['height'], 'MarineRenderRequest.height');

    expect(layerId['maxLength']).toBe(MARINE_RENDER_LAYER_ID_MAX_LENGTH);
    expect(layerId['enum']).toEqual(
      SENTINEL_LAYER_CATALOG.filter((layer) =>
        layer.capabilities.includes(EnvironmentLayerCapability.IMAGERY),
      ).map((layer) => layer.id),
    );
    expect(sceneId['maxLength']).toBe(MARINE_RENDER_SCENE_ID_MAX_LENGTH);
    for (const dimension of [width, height]) {
      expect(dimension['minimum']).toBe(MARINE_RENDER_MIN_DIMENSION);
      expect(dimension['maximum']).toBe(MARINE_RENDER_MAX_DIMENSION);
      expect(dimension['default']).toBe(MARINE_RENDER_DEFAULT_DIMENSION);
    }
  });

  it('documents browser-directed Sentinel routes only as authenticated 410 tombstones', () => {
    const controllerPaths = pathMetadata(SentinelHubProxyController.prototype.retiredBrowserProxy);
    expect(controllerPaths).toEqual(['wms/:layerId', 'process', 'catalog/search']);
    if (!Array.isArray(controllerPaths)) {
      throw new Error('Retired Sentinel controller must declare all tombstone paths');
    }

    const document = openApiDocument();
    for (const route of controllerPaths) {
      const apiPath = `/${RETIRED_SENTINEL_CONTROLLER_PATH}/${route.replace(
        ':layerId',
        '{layerId}',
      )}`;
      const retired = operation(document, apiPath, 'get');
      expect(retired['deprecated']).toBe(true);
      expect(responseCodes(retired)).toEqual(['401', '403', '410']);
    }
  });
});
