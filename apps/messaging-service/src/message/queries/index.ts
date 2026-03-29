import { GetMessagesHandler as _GetMessagesHandler } from './get-messages.handler';
import { GetMessagesSinceHandler as _GetMessagesSinceHandler } from './get-messages-since.handler';
import { SearchMessagesHandler as _SearchMessagesHandler } from './search-messages.handler';

export { GetMessagesQuery } from './get-messages.query';
export { GetMessagesHandler, MessagePage } from './get-messages.handler';
export { GetMessagesSinceQuery } from './get-messages-since.query';
export { GetMessagesSinceHandler } from './get-messages-since.handler';
export { SearchMessagesQuery } from './search-messages.query';
export { SearchMessagesHandler } from './search-messages.handler';

/** All query handlers — register in MessageModule */
export const QueryHandlers = [
  _GetMessagesHandler,
  _GetMessagesSinceHandler,
  _SearchMessagesHandler,
];
