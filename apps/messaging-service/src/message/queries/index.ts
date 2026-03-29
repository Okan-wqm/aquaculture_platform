export { GetMessagesQuery } from './get-messages.query';
export { GetMessagesHandler, MessagePage } from './get-messages.handler';
export { GetMessagesSinceQuery } from './get-messages-since.query';
export { GetMessagesSinceHandler } from './get-messages-since.handler';
export { SearchMessagesQuery } from './search-messages.query';
export { SearchMessagesHandler } from './search-messages.handler';

/** All query handlers — register in MessageModule */
export const QueryHandlers = [
  GetMessagesHandler,
  GetMessagesSinceHandler,
  SearchMessagesHandler,
];
