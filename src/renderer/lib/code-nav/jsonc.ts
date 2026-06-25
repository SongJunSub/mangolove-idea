/**
 * Minimal JSONC parser for tsconfig.json, which permits `//` line comments, `/* *\/`
 * block comments, and trailing commas — none of which JSON.parse accepts.
 *
 * stripJsonc walks the text in a single pass, honoring string literals (so a `//` or a
 * trailing-looking comma INSIDE a string is preserved), removes comments, and drops a
 * comma immediately preceding a `}`/`]`. The cleaned text is handed to JSON.parse, which
 * still rejects genuinely malformed input — callers treat a throw as "no config" and
 * fall back, so this stays deliberately small rather than a full tolerant parser.
 */

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Strips JSONC comments + trailing commas, preserving string contents verbatim. Output is
 * accumulated in an array and a trailing comma is nulled in place via a remembered index, so
 * the whole pass is O(n). (A per-comma full-string rebuild — out = out.slice(0,j)+... — is
 * O(n^2) and lets a single ~5 MiB malicious tsconfig pin the renderer thread for minutes.)
 */
function stripJsonc(text: string): string {
  const parts: string[] = [];
  let i = 0;
  const n = text.length;
  let inString = false;
  // The parts index of a comma seen with only whitespace/comments after it so far, else -1.
  let pendingCommaIndex = -1;

  while (i < n) {
    const ch = text[i];

    if (inString) {
      if (ch === '\\' && i + 1 < n) {
        parts.push(ch + text[i + 1]); // copy the escaped pair verbatim
        i += 2;
      } else {
        parts.push(ch);
        if (ch === '"') inString = false;
        i++;
      }
      pendingCommaIndex = -1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      parts.push(ch);
      pendingCommaIndex = -1;
      i++;
      continue;
    }

    if (ch === '/' && i + 1 < n && text[i + 1] === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i++;
      continue; // a comment does not clear a pending trailing comma
    }

    if (ch === '/' && i + 1 < n && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && i + 1 < n && text[i + 1] === '/')) i++;
      i += 2; // consume the closing */
      continue;
    }

    if (ch === '}' || ch === ']') {
      if (pendingCommaIndex !== -1) parts[pendingCommaIndex] = ''; // drop the trailing comma
      parts.push(ch);
      pendingCommaIndex = -1;
      i++;
      continue;
    }

    if (ch === ',') {
      parts.push(',');
      pendingCommaIndex = parts.length - 1;
      i++;
      continue;
    }

    parts.push(ch);
    if (!isWhitespace(ch)) pendingCommaIndex = -1; // whitespace keeps a pending comma alive
    i++;
  }

  return parts.join('');
}

/** Parses JSONC text. Throws (like JSON.parse) on malformed input — callers fail closed. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}
