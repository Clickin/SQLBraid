import type {
  BulkBindingDescription,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
} from "@sqlbraid/core";
import {
  createBulkBindingDescription,
  createRenderedStatement,
  createStatementBindingDescription,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { unsupported } from "./errors.js";

export function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (
    rendered.parameters.some(
      (parameter) => parameter.hint !== undefined && !(rendered.resultKind === "call" && isRefcursor(parameter)),
    )
  ) {
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "PostgreSQL adapter does not support explicit bind type hints.",
    );
  }
}

export function assertPgRoutineDirections(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.direction === "inout")) {
    throw unsupported(
      "routine.inout",
      "BRAID_CALL_OUT_UNSUPPORTED",
      "The PostgreSQL adapter does not expose a verified INOUT carrier contract.",
    );
  }
}

function assertPgRoutineCallContext(rendered: RenderedStatement): void {
  if (
    rendered.resultKind !== "call" &&
    rendered.parameters.some((parameter) => parameter.direction !== undefined && parameter.direction !== "in")
  ) {
    throw unsupported(
      "routine.out",
      "BRAID_CALL_OUT_UNSUPPORTED",
      "PostgreSQL OUT parameters are only valid for routine calls.",
    );
  }
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();
const bindingContexts = new WeakMap<StatementBindingDescription, StatementBindingContext>();

export function isRefcursor(parameter: RenderedStatement["parameters"][number]): boolean {
  return (
    parameter.direction !== undefined &&
    parameter.direction !== "in" &&
    parameter.hint?.databaseType.trim().toLowerCase() === "refcursor"
  );
}

export function hasRefcursor(rendered: RenderedStatement): boolean {
  return rendered.parameters.some(isRefcursor);
}

export const pgStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "pg",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    if (hasRefcursor(statement) && context.transactionScoped !== true) {
      throw unsupported(
        "routine.out-cursor",
        "BRAID_CALL_CURSOR_TX_REQUIRED",
        "PostgreSQL refcursor calls require an existing transaction.",
      );
    }
    assertPgRoutineCallContext(statement);
    assertPgRoutineDirections(statement);
    assertParameterHintsUnsupported(statement);
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "pg",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
    describedStatements.set(description, statement);
    bindingContexts.set(description, context);
    return description;
  },
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
    const statement = createRenderedStatement(bulk.statement);
    if (statement.resultKind !== "command")
      throw new Error("BRAID_BULK_SHAPE: PostgreSQL bulk requires command queries.");
    if (statement.parameters.some((parameter) => (parameter.direction ?? "in") !== "in")) {
      throw unsupported("routine.out", "BRAID_BULK_SHAPE", "PostgreSQL bulk does not support OUT or INOUT parameters.");
    }
    assertParameterHintsUnsupported(statement);
    for (const values of bulk.parameterSets) {
      if (values.length !== statement.parameters.length)
        throw new Error("BRAID_BULK_SHAPE: PostgreSQL bulk parameter cardinality changed.");
    }
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "pg",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "reuse", owner: "driver" },
    });
    describedBulks.set(description, bulk);
    return description;
  },
});

const defaultBindingContext: StatementBindingContext = Object.freeze({
  dialectId: "postgres",
  requestedReuse: "auto",
});

/** Return the parameterized text and the values for one rendered statement. */
export function resolvePgBinding(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description =
    binding ??
    pgStatementBinding.describe(statement, {
      dialectId: statement.dialectId,
      requestedReuse: defaultBindingContext.requestedReuse,
    });
  if (describedStatements.get(description) !== statement)
    throw new TypeError("BRAID_BINDING_IDENTITY: PostgreSQL description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: PostgreSQL binding description did not provide parameterized SQL.");
  }
  return { text: description.parameterizedSql, values: statement.parameters.map((parameter) => parameter.value) };
}

/** True if the binding description was made for a statement inside a transaction. */
export function isTransactionScoped(binding: StatementBindingDescription | undefined): boolean {
  return binding === undefined ? false : bindingContexts.get(binding)?.transactionScoped === true;
}

/** Check that a bulk binding description belongs to this adapter and to this bulk. */
export function assertPgBulkBinding(bulk: RenderedBulk, binding: BulkBindingDescription): void {
  const described = describedBulks.get(binding);
  if (described !== bulk)
    throw new TypeError("BRAID_BINDING_IDENTITY: PostgreSQL bulk description belongs to another bulk or adapter.");
  if (binding.adapterId !== pgStatementBinding.id || binding.dialectId !== bulk.statement.dialectId) {
    throw new TypeError("BRAID_BINDING_IDENTITY: PostgreSQL bulk description belongs to another adapter.");
  }
  if (binding.parameterizedSql === undefined)
    throw new Error("BRAID_BIND_TRANSPORT: PostgreSQL bulk binding did not provide parameterized SQL.");
}
