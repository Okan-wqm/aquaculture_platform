/**
 * Type definitions for node-opcua library
 * @see https://github.com/node-opcua/node-opcua
 */

/**
 * OPC-UA Client interface
 */
export interface OPCUAClient {
  /** Connect to server */
  connect(endpointUrl: string): Promise<void>;

  /** Create a session */
  createSession(userIdentityInfo?: UserIdentityInfo): Promise<OPCUASession>;

  /** Disconnect from server */
  disconnect(): Promise<void>;

  /** Check if connected */
  isReconnecting: boolean;
}

/**
 * OPC-UA Session interface
 */
export interface OPCUASession {
  /** Read a single node value */
  read(nodeToRead: ReadValueId): Promise<DataValue>;

  /** Read multiple node values */
  read(nodesToRead: ReadValueId[]): Promise<DataValue[]>;

  /** Write a single value */
  write(nodeToWrite: WriteValue): Promise<StatusCode>;

  /** Write multiple values */
  write(nodesToWrite: WriteValue[]): Promise<StatusCode[]>;

  /** Browse nodes */
  browse(nodeToBrowse: BrowseDescription | string): Promise<BrowseResult>;

  /** Create subscription for monitoring */
  createSubscription2(options: SubscriptionOptions): Promise<OPCUASubscription>;

  /** Close the session */
  close(): Promise<void>;
}

/**
 * OPC-UA Subscription interface
 */
export interface OPCUASubscription {
  /** Create a monitored item */
  monitor(
    itemToMonitor: ReadValueId,
    requestedParameters: MonitoringParameters,
    timestampsToReturn: TimestampsToReturn,
  ): Promise<MonitoredItem>;

  /** Terminate the subscription */
  terminate(): Promise<void>;

  /** Subscription ID */
  subscriptionId: number;
}

/**
 * Monitored Item interface
 */
export interface MonitoredItem {
  /** Event emitter for value changes */
  on(event: 'changed', listener: (dataValue: DataValue) => void): this;
  on(event: 'err', listener: (error: Error) => void): this;

  /** Monitored item ID */
  monitoredItemId: number;
}

/**
 * User identity for session creation
 */
export interface UserIdentityInfo {
  type?: UserTokenType;
  userName?: string;
  password?: string;
  certificateData?: Buffer;
  privateKey?: string;
}

export enum UserTokenType {
  Anonymous = 0,
  UserName = 1,
  Certificate = 2,
  IssuedToken = 3,
}

/**
 * Read value identifier
 */
export interface ReadValueId {
  nodeId: NodeId | string;
  attributeId?: AttributeIds;
  indexRange?: string;
  dataEncoding?: QualifiedName;
}

/**
 * Write value
 */
export interface WriteValue {
  nodeId: NodeId | string;
  attributeId?: AttributeIds;
  indexRange?: string;
  value: DataValue;
}

/**
 * Node ID types
 */
export type NodeId = string | {
  namespace: number;
  identifierType: NodeIdType;
  value: string | number | Buffer;
};

export enum NodeIdType {
  Numeric = 0,
  String = 1,
  Guid = 2,
  ByteString = 3,
}

/**
 * Data value container
 */
export interface DataValue {
  value?: Variant;
  statusCode?: StatusCode;
  sourceTimestamp?: Date;
  serverTimestamp?: Date;
  sourcePicoseconds?: number;
  serverPicoseconds?: number;
}

/**
 * Variant - universal value container
 */
export interface Variant {
  dataType: DataType;
  arrayType?: VariantArrayType;
  value: unknown;
}

export enum DataType {
  Null = 0,
  Boolean = 1,
  SByte = 2,
  Byte = 3,
  Int16 = 4,
  UInt16 = 5,
  Int32 = 6,
  UInt32 = 7,
  Int64 = 8,
  UInt64 = 9,
  Float = 10,
  Double = 11,
  String = 12,
  DateTime = 13,
  Guid = 14,
  ByteString = 15,
}

export enum VariantArrayType {
  Scalar = 0,
  Array = 1,
  Matrix = 2,
}

/**
 * Status code
 */
export interface StatusCode {
  value: number;
  name: string;
  description: string;
  isGood(): boolean;
  isBad(): boolean;
  isUncertain(): boolean;
}

/**
 * Browse description
 */
export interface BrowseDescription {
  nodeId: NodeId | string;
  browseDirection?: BrowseDirection;
  referenceTypeId?: NodeId | string;
  includeSubtypes?: boolean;
  nodeClassMask?: number;
  resultMask?: number;
}

export enum BrowseDirection {
  Forward = 0,
  Inverse = 1,
  Both = 2,
}

/**
 * Browse result
 */
export interface BrowseResult {
  statusCode: StatusCode;
  continuationPoint?: Buffer;
  references?: ReferenceDescription[];
}

/**
 * Reference description
 */
export interface ReferenceDescription {
  referenceTypeId: NodeId;
  isForward: boolean;
  nodeId: NodeId;
  browseName: QualifiedName;
  displayName: LocalizedText;
  nodeClass: NodeClass;
  typeDefinition?: NodeId;
}

export interface QualifiedName {
  namespaceIndex: number;
  name: string;
}

export interface LocalizedText {
  locale?: string;
  text: string;
}

export enum NodeClass {
  Unspecified = 0,
  Object = 1,
  Variable = 2,
  Method = 4,
  ObjectType = 8,
  VariableType = 16,
  ReferenceType = 32,
  DataType = 64,
  View = 128,
}

/**
 * Attribute IDs
 */
export enum AttributeIds {
  NodeId = 1,
  NodeClass = 2,
  BrowseName = 3,
  DisplayName = 4,
  Description = 5,
  WriteMask = 6,
  UserWriteMask = 7,
  IsAbstract = 8,
  Symmetric = 9,
  InverseName = 10,
  ContainsNoLoops = 11,
  EventNotifier = 12,
  Value = 13,
  DataType = 14,
  ValueRank = 15,
  ArrayDimensions = 16,
  AccessLevel = 17,
  UserAccessLevel = 18,
  MinimumSamplingInterval = 19,
  Historizing = 20,
  Executable = 21,
  UserExecutable = 22,
}

/**
 * Subscription options
 */
export interface SubscriptionOptions {
  requestedPublishingInterval?: number;
  requestedLifetimeCount?: number;
  requestedMaxKeepAliveCount?: number;
  maxNotificationsPerPublish?: number;
  publishingEnabled?: boolean;
  priority?: number;
}

/**
 * Monitoring parameters
 */
export interface MonitoringParameters {
  samplingInterval?: number;
  filter?: unknown;
  queueSize?: number;
  discardOldest?: boolean;
}

export enum TimestampsToReturn {
  Source = 0,
  Server = 1,
  Both = 2,
  Neither = 3,
}

/**
 * Client options for creation
 */
export interface OPCUAClientOptions {
  applicationName?: string;
  connectionStrategy?: {
    maxRetry?: number;
    initialDelay?: number;
    maxDelay?: number;
  };
  securityMode?: MessageSecurityMode;
  securityPolicy?: SecurityPolicy;
  endpointMustExist?: boolean;
  keepSessionAlive?: boolean;
  requestedSessionTimeout?: number;
}

export enum MessageSecurityMode {
  None = 1,
  Sign = 2,
  SignAndEncrypt = 3,
}

export enum SecurityPolicy {
  None = 'http://opcfoundation.org/UA/SecurityPolicy#None',
  Basic128Rsa15 = 'http://opcfoundation.org/UA/SecurityPolicy#Basic128Rsa15',
  Basic256 = 'http://opcfoundation.org/UA/SecurityPolicy#Basic256',
  Basic256Sha256 = 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256',
}

/**
 * Helper to create an OPC-UA client from dynamic import
 */
export async function createOPCUAClient(options?: OPCUAClientOptions): Promise<OPCUAClient> {
  const opcua = await import('node-opcua');
  return opcua.OPCUAClient.create(options ?? {}) as OPCUAClient;
}

/**
 * Convert OPC-UA quality to numeric code (0-255)
 * OPC-UA quality maps to IEC 61131-3 quality codes
 */
export function opcuaQualityToCode(statusCode: StatusCode): number {
  if (statusCode.isGood()) {
    return 192; // Good quality
  } else if (statusCode.isUncertain()) {
    return 64; // Uncertain quality
  } else {
    return 0; // Bad quality
  }
}
