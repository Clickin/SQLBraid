import assert from "node:assert/strict";
import type { ExecutionObserver, ParameterTransportKind, QueryReadyEvent } from "@sqlbraid/core";

export function bindingObserver(dialectId: string, transport: ParameterTransportKind) {
  let ready: QueryReadyEvent | undefined;
  const observer: ExecutionObserver = {
    onEvent(event) {
      if (event.type === "query:ready") ready = event;
    },
  };
  return {
    observer,
    verify(parameterized: string) {
      assert.ok(ready);
      assert.equal(ready.execution.dialectId, dialectId);
      assert.equal(ready.execution.transport, transport);
      assert.equal(ready.sql, parameterized);
      assert.deepEqual(ready.values, ["O'Reilly"]);
      const inline = ready.literalizedSql({ values: "inline" });
      assert.ok(inline.text.includes("'O''Reilly'"));
      assert.ok(inline.text.includes("'$1 ? :1 @p1'"));
      assert.ok(inline.text.includes("/* $1 ? :1 @p1 */"));
      assert.equal(inline.complete, true);
      const redacted = ready.literalizedSql();
      assert.equal(redacted.redactedParameters, 1);
      assert.equal(redacted.text.includes("O'Reilly"), false);
      assert.equal(redacted.text.includes("O''Reilly"), false);
    },
  };
}
