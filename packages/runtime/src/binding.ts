import { preparedShape } from "./prepared-shape.js";
import type {
  BulkBindingDescription,
  ConnectionProvider,
  QueryExecutor,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingDescription,
} from "@sqlbraid/core";

export function bindingAdapterFor(resource: QueryExecutor | ConnectionProvider): StatementBindingAdapter {
  const adapter = resource.statementBinding;
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    typeof adapter.id !== "string" ||
    adapter.id.length === 0 ||
    typeof adapter.describe !== "function"
  ) {
    throw new TypeError("Execution resource returned an invalid statement binding adapter.");
  }
  return adapter;
}

export function assertBindingDescription(
  description: StatementBindingDescription,
  adapter: StatementBindingAdapter,
  statement: RenderedStatement,
): StatementBindingDescription {
  const effective = statement.dialectId;
  const validTransport =
    description !== null &&
    typeof description === "object" &&
    (description.transport === "native-value-template" ||
      description.transport === "text-positional" ||
      description.transport === "text-named" ||
      description.transport === "typed-request");
  const validReuseOwner =
    description !== null &&
    typeof description === "object" &&
    (description.reuse?.owner === "sqlbraid" ||
      description.reuse?.owner === "driver" ||
      description.reuse?.owner === "server");
  if (
    description === null ||
    typeof description !== "object" ||
    description.adapterId !== adapter.id ||
    description.dialectId !== effective ||
    !validTransport ||
    !Array.isArray(description.bindings) ||
    description.bindings.length !== statement.parameters.length ||
    description.reuse === null ||
    typeof description.reuse !== "object" ||
    description.reuse.requested === undefined ||
    (description.reuse.requested !== "auto" &&
      description.reuse.requested !== "simple" &&
      description.reuse.requested !== "reuse") ||
    (description.reuse.effective !== "simple" && description.reuse.effective !== "reuse") ||
    !validReuseOwner ||
    typeof description.literalizedSql !== "function"
  ) {
    throw new TypeError("Statement binding adapter returned an invalid description.");
  }
  if (
    description.reuse.capacity !== undefined &&
    (!Number.isInteger(description.reuse.capacity) || description.reuse.capacity < 0)
  ) {
    throw new TypeError("Statement binding adapter returned an invalid reuse capacity.");
  }
  for (const [offset, binding] of description.bindings.entries()) {
    if (
      binding === null ||
      typeof binding !== "object" ||
      binding.index !== offset + 1 ||
      binding.interpolation !== statement.parameters[offset].interpolation ||
      binding.direction !== statement.parameters[offset].direction ||
      binding.outputName !== statement.parameters[offset].outputName
    ) {
      throw new TypeError("Statement binding adapter returned misaligned bindings.");
    }
    const expectedHint = statement.parameters[offset].hint;
    const actualHint = binding.hint;
    if (
      (expectedHint === undefined) !== (actualHint === undefined) ||
      (expectedHint !== undefined &&
        (actualHint!.databaseType !== expectedHint.databaseType ||
          actualHint!.length !== expectedHint.length ||
          actualHint!.precision !== expectedHint.precision ||
          actualHint!.scale !== expectedHint.scale))
    ) {
      throw new TypeError("Statement binding adapter returned misaligned parameter hints.");
    }
    if (actualHint !== undefined && !Object.isFrozen(actualHint)) Object.freeze(actualHint);
    if (!Object.isFrozen(binding)) Object.freeze(binding);
  }
  if (!Object.isFrozen(description.bindings)) Object.freeze(description.bindings);
  if (!Object.isFrozen(description.reuse)) Object.freeze(description.reuse);
  if (!Object.isFrozen(description)) Object.freeze(description);
  return description;
}

export function assertBulkBindingDescription(
  description: BulkBindingDescription,
  adapter: StatementBindingAdapter,
  bulk: RenderedBulk,
): BulkBindingDescription {
  const statement = bulk.statement;
  const validTransport =
    description !== null &&
    typeof description === "object" &&
    (description.transport === "native-value-template" ||
      description.transport === "text-positional" ||
      description.transport === "text-named" ||
      description.transport === "typed-request");
  if (
    description === null ||
    typeof description !== "object" ||
    description.adapterId !== adapter.id ||
    description.dialectId !== statement.dialectId ||
    !validTransport ||
    !Array.isArray(description.bindings) ||
    description.bindings.length !== statement.parameters.length ||
    description.itemCount !== bulk.parameterSets.length ||
    typeof description.valuesAt !== "function" ||
    typeof description.literalizedSql !== "function"
  ) {
    throw new TypeError("Statement binding adapter returned an invalid bulk description.");
  }
  if (
    (description.transport === "text-positional" || description.transport === "text-named") &&
    typeof description.parameterizedSql !== "string"
  ) {
    throw new TypeError("BRAID_BIND_TRANSPORT: text bulk binding descriptions must provide parameterized SQL.");
  }
  for (const [offset, binding] of description.bindings.entries()) {
    if (
      binding === null ||
      typeof binding !== "object" ||
      binding.index !== offset + 1 ||
      binding.interpolation !== statement.parameters[offset].interpolation ||
      binding.direction !== statement.parameters[offset].direction ||
      binding.outputName !== statement.parameters[offset].outputName
    ) {
      throw new TypeError("Statement binding adapter returned misaligned bulk bindings.");
    }
    const expectedHint = statement.parameters[offset].hint;
    const actualHint = binding.hint;
    if (
      (expectedHint === undefined) !== (actualHint === undefined) ||
      (expectedHint !== undefined &&
        (actualHint!.databaseType !== expectedHint.databaseType ||
          actualHint!.length !== expectedHint.length ||
          actualHint!.precision !== expectedHint.precision ||
          actualHint!.scale !== expectedHint.scale))
    ) {
      throw new TypeError("Statement binding adapter returned misaligned bulk parameter hints.");
    }
    if (actualHint !== undefined && !Object.isFrozen(actualHint)) Object.freeze(actualHint);
    if (!Object.isFrozen(binding)) Object.freeze(binding);
  }
  if (!Object.isFrozen(description.bindings)) Object.freeze(description.bindings);
  if (!Object.isFrozen(description)) Object.freeze(description);
  return description;
}

export function bulkShape(rendered: RenderedStatement): string {
  return preparedShape("command", rendered);
}

export function bindingIdentityMismatch(): TypeError {
  const error = new TypeError(
    "BRAID_BINDING_IDENTITY: leased execution resource uses a different statement binding adapter.",
  );
  return error;
}

export function isBindingIdentityMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("BRAID_BINDING_IDENTITY:");
}
