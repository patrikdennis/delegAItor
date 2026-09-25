import type { NormalizedTicket, TicketSource } from "../types.js";

export interface MarkdownSourceOptions {
  defaultRepoId: string;
  defaultRepoPath: string;
  defaultBaseRef?: string;
}

const LINE_RE = /^\s*[-*]\s+(?:\[([\w.-]+\/[\w.-]+)\]\s*)?(?:\(after\s+([^)]+)\)\s*)?(.+)$/;
const META_RE = /^\s*(repo|base|agent)\s*:\s*(.+)$/i;

/**
 * Parses a plain-text/markdown ticket list, e.g.:
 *
 *   repo: owner/repo
 *   base: main
 *
 *   - Fix validation of customer IDs
 *   - [checkout-service] (after Fix validation of customer IDs) Update retry behavior
 *
 * Lines are treated as free-standing tickets with no external tracker;
 * `[repo]` overrides the target repo per-line, and `(after X)` records an
 * in-batch dependency by matching another ticket's title text.
 */
export function markdownTicketSource(opts: MarkdownSourceOptions): TicketSource {
  return {
    kind: "markdown",
    async resolve(input: string): Promise<NormalizedTicket[]> {
      let repoId = opts.defaultRepoId;
      let repoPath = opts.defaultRepoPath;
      let baseRef = opts.defaultBaseRef ?? "main";
      const raw: { title: string; repoId: string; repoPath: string; baseRef: string; after?: string }[] = [];

      for (const line of input.split("\n")) {
        const meta = line.match(META_RE);
        if (meta) {
          const [, key, value] = meta;
          if (key.toLowerCase() === "repo") {
            repoId = value.trim();
            repoPath = value.trim();
          }
          if (key.toLowerCase() === "base") baseRef = value.trim();
          continue;
        }
        const m = line.match(LINE_RE);
        if (!m) continue;
        const [, repoOverride, after, title] = m;
        raw.push({
          title: title.trim(),
          repoId: repoOverride ?? repoId,
          repoPath: repoOverride ?? repoPath,
          baseRef,
          after: after?.trim(),
        });
      }

      const byTitle = new Map(raw.map((t, i) => [t.title, `local-${i + 1}`]));
      return raw.map((t, i) => ({
        source: "markdown" as const,
        externalId: `local-${i + 1}`,
        title: t.title,
        repoId: t.repoId,
        repoPath: t.repoPath,
        baseRef: t.baseRef,
        dependsOn: t.after ? [byTitle.get(t.after) ?? t.after] : undefined,
      }));
    },
  };
}
