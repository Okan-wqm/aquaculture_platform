import type { Logger } from 'typeorm';

/**
 * A TypeORM logger that records the statements a block of work sends — the
 * round trips a read costs, counted where they leave the process. TypeORM
 * hands every statement of a data source to its logger, raw queries included.
 * Outside `record` nothing is kept.
 */
export class StatementLog implements Logger {
  private recording: string[] | null = null;

  logQuery(query: string): void {
    this.recording?.push(query);
  }

  logQueryError(): void {}

  logQuerySlow(): void {}

  logSchemaBuild(): void {}

  logMigration(): void {}

  log(): void {}

  /** The statements `work` sent, in order, with its result. */
  async record<T>(work: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
    const statements: string[] = [];
    this.recording = statements;
    try {
      return { result: await work(), statements };
    } finally {
      this.recording = null;
    }
  }
}
