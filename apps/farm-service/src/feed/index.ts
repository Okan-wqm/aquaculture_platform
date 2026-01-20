/**
 * Feed Module Exports
 */
export * from './feed.module';
export * from './entities/feed.entity';
export * from './entities/feeding-protocol.entity';
export * from './dto';

// Export commands (class only, not re-exported types)
export { CreateFeedCommand } from './commands/create-feed.command';
export { UpdateFeedCommand } from './commands/update-feed.command';
export { DeleteFeedCommand } from './commands/delete-feed.command';

// Export queries
export * from './queries/get-feed.query';
export * from './queries/list-feeds.query';
