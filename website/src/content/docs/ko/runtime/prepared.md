---
title: 준비된 쿼리
description: 네이티브 driver 준비를 약속하지 않고 안정적인 SQLBraid query shape를 재사용합니다.
---

이름이 있는 input factory를 등록합니다(기본값은 required input입니다).

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

required-input contract를 명시하려면 다음과 같이 작성할 수 있습니다.

```ts
const byId = db.prepare("user-by-id", (id: string) => sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`, {
  input: "required",
});
```

zero-input factory는 `{ input: "none" }`을 명시해야 합니다.

```ts
const users = db.prepare("users", () => sql.rows<UserRow>`SELECT id, name FROM users`, { input: "none" });
await users.all({ signal });
```

input shape는 `Function.length`나 option처럼 보이는 input 값의 추측이 아니라
명시적인 public contract입니다. Optional/default/rest/wrapped one-input
factory는 `{ input: "required" }`를 명시할 수 있습니다. 값이 `undefined`인
required input도 여전히 input이며, zero-input 형식만
`PreparedQuery<never, Q>`를 사용합니다. 여러 필드가 필요하면 하나의
object를 전달하세요.

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

Factory는 매 실행마다 평가되고 한 번 렌더링됩니다. SQLBraid는 첫 logical
shape—result kind, dialect, canonical `segments`, 순서 있는 hint/direction/
output metadata—를 shape lock으로 기록합니다. 값은 바꿀 수 있습니다. 이후
shape 변경은 driver I/O 전에 `BRAID_PREPARED_SHAPE`로 실패합니다. 물리적인
`$1`, `?`, `:1`, `@p1` 표기는 transport 세부 사항이며 shape identity를
바꾸지 않습니다. 이름은 비어 있거나 중복될 수 없습니다
(`BRAID_PREPARED_NAME`).

Prepared operation은 result kind를 따릅니다.

- row query는 `execute`, `all`, `one`, `maybeOne`, `stream`을 제공합니다.
- command와 unknown query는 `execute`를 제공합니다.
- call query는 `call`을 제공합니다.

모든 operation은 trailing option을 사용합니다. Row operation은 schema와
signal을 받고 `stream`은 driver cleanup까지 물리 lease를 유지합니다. 이미
abort된 signal은 자신의 `reason`으로 거부되고, 활성 signal에는 adapter
cancellation이 필요합니다. 없으면 I/O 전에 `UnsupportedFeatureError` /
`BRAID_CANCEL_UNSUPPORTED`로 실패합니다.

Prepared는 안정적인 SQLBraid application shape를 뜻합니다. `auto`, `simple`,
`reuse` 중 유효한 방식은 driver가 선택하며 runtime은 범용 native prepared
statement나 server-plan cache를 추가하지 않습니다. Prepared event는
shape-lock 이름과 유효 binding plan을 observer에 노출합니다.
