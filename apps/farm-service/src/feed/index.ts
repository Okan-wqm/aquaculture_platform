/**
 * Feed Module Exports
 */
export * from './feed.module';
export * from './entities/feed.entity';
export * from './entities/feeding-protocol.entity';
export * from './dto';

// Export Feed commands (class only, not re-exported types)
export { CreateFeedCommand } from './commands/create-feed.command';
export { UpdateFeedCommand } from './commands/update-feed.command';
export { DeleteFeedCommand } from './commands/delete-feed.command';

// Export Feed queries
export * from './queries/get-feed.query';
export * from './queries/list-feeds.query';

// Export Feeding Protocol commands
export { CreateFeedingProtocolCommand } from './commands/create-feeding-protocol.command';
export { UpdateFeedingProtocolCommand } from './commands/update-feeding-protocol.command';
export { DeleteFeedingProtocolCommand } from './commands/delete-feeding-protocol.command';

// Export Feeding Protocol queries
export * from './queries/get-feeding-protocol.query';
export * from './queries/list-feeding-protocols.query';
