# Writing style

SQLBraid documentation uses a simplified form of ASD-STE100 Simplified Technical
English (STE). We apply about 80% of STE. The goal is text that is easy to read,
easy to translate and difficult to misunderstand.

This page applies to all English Markdown in the repository: READMEs, `docs/`,
website pages, package READMEs, examples and agent skills. Korean pages follow
the same structure and the same rules where Korean grammar permits.

## Rules we apply

### Sentences

- Write one idea in each sentence.
- Keep procedural sentences (instructions) to 20 words or fewer.
- Keep descriptive sentences to 25 words or fewer.
- Use the active voice. Name the actor: "The runtime releases the lease", not
  "The lease is released".
- Use simple tenses: present, simple past and future.
- Do not omit articles (`a`, `an`, `the`) or verbs to make text shorter.

### Instructions

- Write instructions in the imperative: "Install the driver", not "You should
  install the driver".
- Write one instruction in each sentence. Put a condition first: "If the stream
  stays open, close it".
- Use a numbered list for steps that must occur in sequence.
- Start a warning with a clear command, then give the reason.

### Paragraphs and lists

- Give each paragraph one topic.
- Keep a paragraph to six sentences or fewer.
- Use a vertical list for three or more parallel items.
- Use a table for facts that have the same attributes.

### Words

- Use one word for one meaning. If a page uses "lease", do not also call the
  same thing a "handle" or a "connection object".
- Use common, short words: "use" (not "utilize"), "start" (not "initiate"),
  "help" (not "facilitate"), "about" (not "approximately").
- Do not use idioms, slang, metaphors or jokes.
- Do not use phrasal verbs when one verb is available: "remove" (not "get rid
  of"), "continue" (not "carry on").
- Do not use "contract" outside a legal context. Use a specific word: "rule",
  "interface", "behavior", "declared type", "requirement" or "guarantee".
- Do not use vague words: "simply", "just", "obviously", "easily", "etc.".
- Avoid noun clusters of more than three nouns. Use a preposition to break them:
  "the lease of the transaction", not "transaction lease release order".

## The 20% we relax

Full STE is too strict for a TypeScript library. We relax these rules:

- **Technical names.** Use product, API, type, package, SQL and driver names
  exactly as they are. STE dictionary limits do not apply to them.
- **Domain terms.** Use established terms such as "bind", "lease", "savepoint",
  "stream", "pool", "dialect" and "schema". Define a term the first time a page
  uses it if a new reader can misunderstand it.
- **Passive voice.** Use the passive voice in descriptive text when the actor is
  unknown or not important: "Unsupported options are rejected".
- **-ing forms.** Use an -ing form when it is a fixed technical term
  ("streaming", "pooling", "logging") or a heading.
- **Sentence length.** The word limits are targets. A sentence can be longer if
  it contains a long API name or a path.
- **Contractions and tone.** Keep a neutral tone. Do not use contractions.

## Things we never change

Style edits must not change meaning. When you edit for style:

- Do not change code blocks, commands, API names, error codes or links.
- Do not change machine-readable blocks, such as the capability vocabulary and
  the facade export inventory. Tests read them.
- Do not change table rows that tests parse, such as error codes.
- Keep a guarantee as strong or as weak as it was. Do not change "must" to
  "should", or "is unsupported" to "is not recommended".
- Keep support labels exact: Official, Compatible, Custom and Unsupported.

## Facts

Simple text that is wrong is worse than complex text that is correct. Check
each claim against the current code before you publish it. `AGENTS.md` lists
the checks. Do not copy a path, a symbol name or a version from an older page
without checking it.

## Examples

| Before                                                                                                      | After                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The lease is released after materialization so that scarce pool connections aren't held while mapping runs. | The runtime releases the lease after it materializes the result. Mapping does not hold a pool connection. |
| You'll probably want to just utilize `db.tx()` here.                                                        | Use `db.tx()`.                                                                                            |
| Bind hint structure is included in executable fingerprints.                                                 | Executable fingerprints include the structure of each bind hint.                                          |
| Get rid of the old adapter before carrying on.                                                              | Remove the old adapter. Then continue.                                                                    |

## Translation

The Korean website pages are translations of the English pages. When you edit
an English page under `website/src/content/docs/`, update the Korean page and
its digest in `website/translation-registry.json`. Run
`pnpm run docs:translations` to check the registry.

Korean text uses the same principles: short sentences, one idea in each
sentence, direct instructions and one term for one meaning.

### Korean style

Write natural Korean, not a word-for-word translation.

- Use a Korean word when one is in common use. Keep English only for code
  identifiers, package and product names, error codes, capability IDs, SQL
  keywords and the support labels (Official, Compatible, Custom, Unsupported,
  Conditional, Pending, Historical).
- Do not stack English nouns ("materialized result set 경계"). Write the meaning
  in Korean ("메모리로 모두 읽은 결과 집합").
- Use the active voice when the actor is known: "런타임이 리스를 반환합니다",
  not "리스가 반환됩니다".
- End sentences with the polite "-니다" form. Write instructions as "-하세요".
- Do not translate an English sentence structure literally. Change the word
  order when Korean needs it.
- Keep code blocks identical to the English page. Translate only diagram labels
  and the text in plain-text figures.

### Korean glossary

Use these terms in all Korean pages. At the first use on a page, you can add
the English term in parentheses.

| English                           | Korean                         |
| --------------------------------- | ------------------------------ |
| query / statement                 | 쿼리 / SQL 문                  |
| bind, bound value                 | 바인딩, 바인딩 값              |
| parameter / placeholder           | 파라미터 / 플레이스홀더        |
| interpolation                     | 보간                           |
| identifier                        | 식별자                         |
| fragment                          | 조각                           |
| directive / lowering              | 지시어 / 변환                  |
| tag / template                    | 태그 / 템플릿                  |
| dialect                           | 방언                           |
| driver / adapter                  | 드라이버 / 어댑터              |
| runtime                           | 런타임                         |
| connection / pool                 | 커넥션 / 풀                    |
| lease, acquire, release           | 리스, 획득, 반환               |
| pin                               | 고정                           |
| discard / poison                  | 폐기 / 사용 불가로 표시        |
| transaction / savepoint / session | 트랜잭션 / 세이브포인트 / 세션 |
| isolation level / read-only       | 격리 수준 / 읽기 전용          |
| commit / rollback                 | 커밋 / 롤백                    |
| stream / cursor                   | 스트림 / 커서                  |
| result set / row / column         | 결과 집합 / 행 / 열            |
| materialize                       | 메모리로 모두 읽다             |
| result kind / cardinality         | 결과 종류 / 행 개수 규칙       |
| prepared query                    | 준비된 쿼리                    |
| shape                             | 형태                           |
| bulk / batch                      | 벌크 / 배치                    |
| routine / procedure               | 루틴 / 프로시저                |
| capability                        | 기능                           |
| support label                     | 지원 등급                      |
| evidence                          | 근거                           |
| profile / representation          | 프로필 / 표현 방식             |
| exact / approximate               | 정확한 / 근사                  |
| lossless / lossy                  | 무손실 / 손실이 있는           |
| fidelity                          | 정확도                         |
| hint                              | 힌트                           |
| observer / event                  | 옵저버 / 이벤트                |
| cancellation / signal / abort     | 취소 / 시그널 / 중단           |
| cleanup                           | 정리                           |
| schema / mapping / validation     | 스키마 / 매핑 / 검증           |
| metadata / snapshot / inspector   | 메타데이터 / 스냅샷 / 인스펙터 |
| code generation                   | 코드 생성                      |
| facade / subpath                  | 파사드 / 하위 경로             |
| peer dependency                   | 피어 의존성                    |
| release (a version)               | 릴리스                         |
