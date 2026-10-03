---
title: 준비된 쿼리
description: 네이티브 드라이버 준비(prepare)를 약속하지 않고, 안정적인 SQLBraid 쿼리 형태를 재사용합니다.
---

이름이 있는 입력 팩토리를 등록하세요. 기본적으로 입력은 필수입니다.

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

필수 입력을 명시할 수도 있습니다.

```ts
const byId = db.prepare("user-by-id", (id: string) => sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`, {
  input: "required",
});
```

입력이 없는 팩토리는 `{ input: "none" }`으로 명시하세요.

```ts
const users = db.prepare("users", () => sql.rows<UserRow>`SELECT id, name FROM users`, { input: "none" });
await users.all({ signal });
```

입력 형태는 명시적인 공개 규칙입니다. SQLBraid는 `Function.length`나 옵션처럼 보이는 입력 값으로 입력 형태를 추측하지 않습니다.

- 선택 인자, 기본값, 나머지 인자, 감싼 단일 입력 팩토리는 `{ input: "required" }`를 선언할 수 있습니다.
- 필수 입력의 값이 `undefined`여도 입력입니다. `PreparedQuery<never, Q>`를 쓰는 것은 입력이 없는 형태뿐입니다.
- 쿼리에 입력 필드가 여러 개 필요하면 객체 하나로 넘기세요.

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

팩토리는 실행할 때마다 평가되고 한 번만 렌더링됩니다. SQLBraid는 처음 렌더링한 논리적 형태를 형태 고정 기준으로 기록합니다. 결과 종류, 방언, 정규화된 `segments`, 그리고 순서가 있는 힌트·방향·출력 메타데이터입니다.

- 값은 바뀌어도 됩니다.
- 이후 형태가 바뀌면 드라이버 I/O 전에 `BRAID_PREPARED_SHAPE`를 던집니다.
- 물리 플레이스홀더 표기 `$1`, `?`, `:1`, `@p1`은 전송 방식마다 다르며, 형태 식별에 영향을 주지 않습니다.
- 이름은 비어 있으면 안 되고 서로 달라야 합니다(`BRAID_PREPARED_NAME`).

준비된 쿼리의 작업은 결과 종류를 따릅니다.

- 행 쿼리는 `execute`, `all`, `one`, `maybeOne`, `stream`을 제공합니다.
- 명령 쿼리와 unknown 쿼리는 `execute`를 제공합니다.
- 호출 쿼리는 `call`을 제공합니다.

모든 작업은 마지막 인자로 옵션을 받습니다. 행 작업은 스키마와 시그널을 받습니다. `stream`은 드라이버 정리가 끝날 때까지 물리 리스를 유지합니다. 시그널이 이미 중단된 상태면 그 `reason`으로 reject됩니다. 활성 시그널을 쓰려면 어댑터가 취소를 지원해야 하며, 지원하지 않으면 I/O 전에 `UnsupportedFeatureError` / `BRAID_CANCEL_UNSUPPORTED`로 실패합니다.

여기서 "준비된"은 안정적인 SQLBraid 애플리케이션 형태를 뜻합니다. `auto`, `simple`, `reuse` 중 무엇이 실제로 적용될지는 드라이버가 고릅니다. 런타임은 범용 네이티브 준비된 문장이나 서버 실행 계획 캐시를 추가하지 않습니다. 준비된 쿼리의 이벤트는 형태 고정 기준의 이름과 실제 바인딩 계획을 옵저버에 보여 줍니다.
