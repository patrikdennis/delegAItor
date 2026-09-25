import { execa } from "execa";
import type { NormalizedTicket, TicketSource } from "../types.js";

const ISSUE_REF = /(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d+))/g;

export interface GithubSourceOptions {
  /** Default "owner/repo" used when a bare "#123" reference is given. */
  defaultRepo?: string;
  /** Local filesystem path for defaultRepo (where the git repo lives on disk). */
  defaultRepoPath?: string;
  /**
   * Also pull open issues assigned to the authenticated `gh` user in
   * defaultRepo, in addition to any explicit "#123" refs found in the
   * input. Requires defaultRepo to be set (scoping to "all my issues
   * everywhere" is deliberately not supported to avoid surprise-dispatching
   * unrelated repos).
   */
  includeAssignedToMe?: boolean;
}

/**
 * Resolves GitHub issue references such as "#1234" or "owner/repo#1234"
 * found anywhere in free-form input text, using the `gh` CLI so it reuses
 * the user's existing GitHub authentication. Optionally also pulls issues
 * assigned to the current user, for the "grab my open tickets" workflow.
 */
export function githubTicketSource(opts: GithubSourceOptions = {}): TicketSource {
  return {
    kind: "github",
    async resolve(input: string): Promise<NormalizedTicket[]> {
      const seen = new Set<string>();
      const tickets: NormalizedTicket[] = [];

      const refs = new Map<string, { repo: string; number: string }>();
      for (const match of input.matchAll(ISSUE_REF)) {
        const repo = match[1] ?? opts.defaultRepo;
        const number = match[2] ?? match[3];
        if (!repo || !number) continue;
        refs.set(`${repo}#${number}`, { repo, number });
      }

      for (const { repo, number } of refs.values()) {
        const key = `${repo}#${number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { stdout } = await execa("gh", [
          "issue",
          "view",
          number,
          "--repo",
          repo,
          "--json",
          "number,title,body,url",
        ]);
        const issue = JSON.parse(stdout) as {
          number: number;
          title: string;
          body: string;
          url: string;
        };
        const repoPath = repo === opts.defaultRepo ? opts.defaultRepoPath : undefined;
        tickets.push({
          source: "github",
          externalId: String(issue.number),
          externalUrl: issue.url,
          title: issue.title,
          body: issue.body,
          repoId: repo,
          repoPath: repoPath ?? repo,
        });
      }

      if (opts.includeAssignedToMe) {
        if (!opts.defaultRepo) {
          throw new Error("githubTicketSource: includeAssignedToMe requires defaultRepo to be set.");
        }
        const { stdout } = await execa("gh", [
          "issue",
          "list",
          "--assignee",
          "@me",
          "--state",
          "open",
          "--repo",
          opts.defaultRepo,
          "--json",
          "number,title,body,url",
        ]);
        const mine = JSON.parse(stdout) as { number: number; title: string; body: string; url: string }[];
        for (const issue of mine) {
          const key = `${opts.defaultRepo}#${issue.number}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tickets.push({
            source: "github",
            externalId: String(issue.number),
            externalUrl: issue.url,
            title: issue.title,
            body: issue.body,
            repoId: opts.defaultRepo,
            repoPath: opts.defaultRepoPath ?? opts.defaultRepo,
          });
        }
      }

      return tickets;
    },
  };
}
