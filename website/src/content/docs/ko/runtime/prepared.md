---
title: 준비된 쿼리
description: 네이티브 driver 준비를 약속하지 않고 안정적인 SQLBraid query shape를 재사용합니다.
---

이름이 있는 input factory를 등록하세요. 기본값은 required input입니다.

```ts
const byId = db.prepare(
  "user-by-id",
  (id: string) => sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id = ${id}
`,
);

const user = await byId.maybeOne("u_1");
const all = await byId.all("u_1", { schema: UserSchema });
for await (const row of byId.stream("u_1", { signal })) consume(row);
```

required input을 명시할 수 있습니다.

```ts
const byId = db.prepare("user-by-id", (id: string) => sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`, {
  input: "required",
});
```

input이 없는 factory는 `{ input: "none" }`을 명시해야 합니다.

```ts
const users = db.prepare("users", () => sql.rows<UserRow>`SELECT id, name FROM users`, { input: "none" });
await users.all({ signal });
```

input shape는 명시적인 public 규칙입니다. SQLBraid는 `Function.length`나
option처럼 보이는 input 값으로 추측하지 않습니다.

- Optional/default/rest/wrapped one-input factory는 `{ input: "required" }`를
  명시할 수 있습니다.
- 값이 `undefined`인 required input도 input입니다. input이 없는 형식만
  `PreparedQuery<never, Q>`를 사용합니다.
- 쿼리에 여러 input 필드가 필요하면 object 하나를 전달하세요.

```ts
const byAccount = db.prepare(
  "account",
  (input: { accountId: string; includeClosed: boolean }) => sql.rows<UserRow>`
    SELECT id, name FROM accounts
    WHERE account_id = ${input.accountId}
      AND (closed = FALSE OR ${input.includeClosed})
  `,
);
await byAccount.all({ accountId: "a_1", includeClosed: false });
```

Factory는 실행마다 평가되고 한 번 렌더링됩니다. SQLBraid는 첫 logical shape를
shape lock으로 기록합니다: result kind, dialect, canonical `segments`, 순서 있는
hint/direction/output metadata.

- 값은 바뀔 수 있습니다.
- 이후 shape가 바뀌면 driver I/O 전에 `BRAID_PREPARED_SHAPE`로 실패합니다.
- 물리적인 `$1`, `?`, `:1`, `@p1` 표기는 transport별 세부 사항입니다. shape
  identity를 바꾸지 않습니다.
- 이름은 비어 있으면 안 되고 중복되면 안 됩니다(`BRAID_PREPARED_NAME`).

Prepared operation은 result kind를 따릅니다.

- row query는 `execute`, `all`, `one`, `maybeOne`, `stream`을 제공합니다.
- command와 unknown query는 `execute`를 제공합니다.
- call query는 `call`을 제공합니다.

모든 operation은 trailing option을 받습니다. Row operation은 schema와 signal을
받습니다. `stream`은 driver cleanup까지 물리 lease를 유지합니다. 이미 abort된
signal은 자신의 `reason`으로 거부됩니다. 활성 signal에는 adapter cancellation이
필요합니다. 없으면 I/O 전에 `UnsupportedFeatureError` /
`BRAID_CANCEL_UNSUPPORTED`로 실패합니다.

Prepared는 안정적인 SQLBraid application shape를 뜻합니다. `auto`, `simple`,
`reuse` 중 어느 것이 유효한지는 driver가 선택합니다. runtime은 범용 native
prepared statement나 server-plan cache를 추가하지 않습니다. Prepared event는
shape lock 이름과 유효 binding plan을 observer에 노출합니다.
