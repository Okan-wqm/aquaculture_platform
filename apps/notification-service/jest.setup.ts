import { Logger } from '@nestjs/common';

// Unit tests assert behavior, not console transport. Keeping Nest's default
// ConsoleLogger active in Jest leaves reporter debounce timers behind when
// services log during construction or lifecycle hooks.
Logger.overrideLogger(false);
