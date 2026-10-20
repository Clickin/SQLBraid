import {
  DriverError,
  type Awaitable,
  type Capabilities,
  type Connection,
  type Result,
  type Statement,
  type TransactionOptions,
} from "./types.js";

export interface NativeOperations {
  execute(statement: Statement): Awaitable<Result<unknown>>;
  begin(options?: TransactionOptions): Awaitable<void>;
  commit(): Awaitable<void>;
  rollback(): Awaitable<void>;
  release(discard: boolean): Awaitable<void>;
  validateTransactionOptions?(options?: TransactionOptions): void;
}

// One live wrapper per physical resource. A failed close never makes it available again.
const owners = new WeakSet<object>();

export function createConnection(key: object, capabilities: Capabilities, native: NativeOperations): Connection {
  if (owners.has(key)) throw new DriverError("BUSY", "The physical resource already has an owner.");
  owners.add(key);
  let busy = false;
  let closed = false;
  let transaction = false;
  let transactionFailed = false;
  let poisoned = false;
  let releasing: Promise<void> | undefined;

  function enter(cleanup = false): void {
    if (closed) throw new DriverError("CLOSED", "The connection has been released.");
    if (busy) throw new DriverError("BUSY", "Await the current operation before using this connection.");
    if (!cleanup && poisoned) throw new DriverError("POISONED", "The physical resource must be discarded.");
    busy = true;
  }

  return {
    capabilities,
    async execute<Row>(statement: Statement, options?: { readonly signal?: AbortSignal }): Promise<Result<Row>> {
      if (!statement || typeof statement.sql !== "string") throw new TypeError("A SQL string is required.");
      if (statement.parameters !== undefined && !Array.isArray(statement.parameters)) {
        throw new TypeError("Parameters must be a positional array.");
      }
      if (statement.parameters !== undefined) {
        for (const value of statement.parameters) {
          if (value === undefined) throw new TypeError("Undefined parameters are not supported.");
        }
      }
      if (options?.signal) {
        options.signal.throwIfAborted();
        throw new DriverError("UNSUPPORTED", "This experimental connection does not implement cancellation.");
      }
      enter();
      try {
        if (transactionFailed)
          throw new DriverError(
            "TRANSACTION_STATE",
            "Roll back the failed transaction before executing another statement.",
          );
        return (await native.execute(statement)) as Result<Row>;
      } catch (error) {
        if (transaction) transactionFailed = true;
        throw error;
      } finally {
        busy = false;
      }
    },
    async begin(options?: TransactionOptions): Promise<void> {
      native.validateTransactionOptions?.(options);
      enter();
      try {
        if (transaction) throw new DriverError("TRANSACTION_STATE", "A transaction is already active.");
        // A failed BEGIN can have reached the server. Cleanup still attempts rollback and discard.
        transaction = true;
        try {
          await native.begin(options);
        } catch (error) {
          poisoned = true;
          throw error;
        }
      } finally {
        busy = false;
      }
    },
    async commit(): Promise<void> {
      enter();
      try {
        if (!transaction || transactionFailed)
          throw new DriverError("TRANSACTION_STATE", "Commit requires an active, successful transaction.");
        try {
          await native.commit();
          transaction = false;
        } catch (error) {
          poisoned = true;
          throw error;
        }
      } finally {
        busy = false;
      }
    },
    async rollback(): Promise<void> {
      enter(true);
      try {
        if (!transaction) throw new DriverError("TRANSACTION_STATE", "There is no active transaction.");
        try {
          await native.rollback();
          transaction = false;
          transactionFailed = false;
        } catch (error) {
          poisoned = true;
          throw error;
        }
      } finally {
        busy = false;
      }
    },
    release(options = {}): Promise<void> {
      if (releasing) return releasing;
      try {
        enter(true);
      } catch (error) {
        return Promise.reject(error);
      }
      closed = true;
      releasing = (async () => {
        const errors: unknown[] = [];
        if (transaction) {
          try {
            await native.rollback();
          } catch (error) {
            poisoned = true;
            errors.push(error);
          }
        }
        try {
          await native.release(poisoned || options.discard === true);
        } catch (error) {
          poisoned = true;
          errors.push(error);
        }
        busy = false;
        if (!poisoned) owners.delete(key);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, "Rollback and connection release failed.", { cause: errors[0] });
      })();
      return releasing;
    },
  };
}
