/**
 * Escape text that can come from a database, a snapshot or a source file before the CLI prints it.
 * Control, bidirectional and unpaired surrogate code units become `\uXXXX`, so that output cannot
 * move the cursor, clear the screen or reorder text. `keepLines` keeps line feeds and tabs in multi-line messages.
 */
export function terminalText(text: string, keepLines = false): string {
  let result = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (keepLines && (code === 0x0a || code === 0x09)) continue;
    let escape = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    escape ||= (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      escape = true;
    } else if (code >= 0xdc00 && code <= 0xdfff) escape = true;
    if (!escape) continue;
    result += `${text.slice(start, index)}\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    start = index + 1;
  }
  return start === 0 ? text : result + text.slice(start);
}
