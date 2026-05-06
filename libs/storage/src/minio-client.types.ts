import { Readable } from 'stream';

export interface MinioClientOptions {
  endPoint: string;
  port?: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region?: string;
}

export interface MinioUploadedObjectInfo {
  etag: string;
  versionId?: string;
}

export interface MinioBucketItem {
  name?: string;
  size: number;
  lastModified: Date;
}

export interface MinioBucketItemStat {
  size: number;
  lastModified: Date;
  etag: string;
  metaData?: Record<string, string>;
}

export interface MinioClientPort {
  bucketExists(bucketName: string): Promise<boolean>;
  makeBucket(bucketName: string, region?: string): Promise<void>;
  putObject(
    bucketName: string,
    objectName: string,
    stream: Buffer | Readable,
    size?: number,
    metaData?: Record<string, string>,
  ): Promise<string | MinioUploadedObjectInfo>;
  removeObject(bucketName: string, objectName: string): Promise<void>;
  presignedGetObject(
    bucketName: string,
    objectName: string,
    expiry?: number,
    respHeaders?: Record<string, string>,
  ): Promise<string>;
  presignedPutObject(
    bucketName: string,
    objectName: string,
    expiry?: number,
  ): Promise<string>;
  listObjects(
    bucketName: string,
    prefix?: string,
    recursive?: boolean,
  ): Readable;
  statObject(bucketName: string, objectName: string): Promise<MinioBucketItemStat>;
  getObject(bucketName: string, objectName: string): Promise<Readable>;
}

export interface MinioSdkPort {
  Client: new (options: MinioClientOptions) => MinioClientPort;
}
