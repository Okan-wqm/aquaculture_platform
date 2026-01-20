declare module 'nodes7' {
  class S7Connection {
    constructor();
    initiateConnection(params: {
      port?: number;
      host: string;
      rack?: number;
      slot?: number;
      timeout?: number;
    }, callback: (err?: Error) => void): void;
    addItems(items: string[]): void;
    readAllItems(callback: (err?: Error, values?: Record<string, unknown>) => void): void;
    writeItems(items: string[], values: unknown[], callback: (err?: Error) => void): void;
    dropConnection(callback?: () => void): void;
  }
  export default S7Connection;
}
