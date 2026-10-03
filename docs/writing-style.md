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
