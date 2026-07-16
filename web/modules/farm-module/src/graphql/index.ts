/**
 * GraphQL Operations Export
 *
 * Farm Module GraphQL query ve mutation'larinin merkezi export noktasi.
 *
 * @module FarmModule/GraphQL
 */

// Feeding Program Operations
export * from './feedingProgram.queries';
export * from './feedingProgram.mutations';

// Growth Operations
export * from './growth.operations';

// Harvest Plan Operations
export * from './harvestPlan.operations';

// Feeding Records & Inventory Operations
export * from './feeding.operations';

// Feeding Protocol Operations
export * from './feedingProtocol.operations';

// Feeding Protocol V2 Operations (birleşik protokol SSoT — Faz 3)
export * from './feedingProtocolV2.operations';

// Regulatory Report Operations
export * from './regulatory.operations';

// Site Setup Operations
export * from './sites.operations';
