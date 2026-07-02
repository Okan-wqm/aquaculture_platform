export interface BatchHarvestedEvent {
  readonly eventType: 'BatchHarvested';
  readonly batchId: string;
}
