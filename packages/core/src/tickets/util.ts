/**
 * Parses a newline-separated block of ticket titles/ids/URLs. When
 * non-empty, this represents an explicit selection that should override
 * any default "assigned to me" / "ready status" filtering — i.e. the user
 * asked for these specific tickets regardless of who owns them.
 */
export function parseWantedLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .filter((l) => !/^\s*(repo|base|agent)\s*:/i.test(l));
}
