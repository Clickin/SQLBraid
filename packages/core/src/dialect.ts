import type { NumericTypeContract } from "./numeric.js";

/** Lexical features the template parser must know to avoid treating SQL text inside comments/quotes as directives. */
export interface DialectLexicalProfile {
  readonly lineCommentPrefixes: readonly string[];
  /** Require whitespace/control after -- (MySQL/MariaDB). Defaults to false. */
  readonly doubleDashRequiresWhitespace?: boolean;
  /** Characters that terminate a line comment. Defaults to CR and LF. */
  readonly lineCommentTerminators?: string;
  readonly supportsNestedBlockComments?: boolean;
  readonly supportsDollarQuotes?: boolean;
  readonly supportsBacktickIdentifiers?: boolean;
  readonly supportsBracketIdentifiers?: boolean;
  readonly supportsOracleQQuotes?: boolean;
  readonly backslashEscapes?: boolean;
}

/** SQL dialect boundary: identifier quoting plus lexical behavior used by template parsing and trimming. */
export interface Dialect {
  readonly id: string;
  quoteIdentifier(identifier: string): string;
  readonly lexicalProfile?: DialectLexicalProfile;
}

/** One database type's input/output representation and numeric fidelity claim. */
export interface TypeMapping {
  readonly databaseType: string;
  readonly inputType: string;
  readonly outputType: string;
  readonly nullable: boolean;
  readonly numeric?: NumericTypeContract;
}

/** Adapter type policy; it normalizes driver values and encodes inputs without becoming a schema validator. */
export interface TypePolicy {
  readonly id: string;
  readonly hash: string;
  readonly mappings: readonly TypeMapping[];
  decode(databaseType: string, value: unknown): unknown;
  encode(databaseType: string, value: unknown): unknown;
}
