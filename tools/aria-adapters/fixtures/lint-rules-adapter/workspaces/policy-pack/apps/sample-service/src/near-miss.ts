// Fixture for lint-rules-adapter: constructs that read like a policy violation
// and are not one. The policy pack must stay silent on every line of this file.
export type Anything = { readonly anyOf: readonly string[] };

export class Reporter {
  public constructor(private readonly logger: { log(message: string): void }) {}

  public report(message: string): void {
    this.logger.log(message);
  }

  public attach(): number {
    const sink = { console: { log: (_message: string): number => 1 } };
    return sink.console.log('a property that is called console');
  }

  public narrow(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch (error: unknown) {
      return String(error);
    }
  }

  public single(value: string): unknown {
    const widened = value as unknown;
    const frozen = ['any'] as const;
    const open: unknown = value;
    return [widened, frozen, open];
  }
}
