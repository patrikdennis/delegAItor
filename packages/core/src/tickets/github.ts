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
  /**
   * Also fetch each issue's comment thread and append it to the ticket
   * body as extra context (defaults to false — it's an extra `gh` call
   * per issue, so opt in when you expect useful discussion in comments).
   */
  includeComments?: boolean;
}

interface GithubComment {
  author?: { login?: string };
  body?: string;
  createdAt?: string;
}

/** Flattens a GitHub issue's comment thread into readable plain text, oldest first. */
function formatComments(comments: GithubComment[] | undefined): string | undefined {
  if (!comments?.length) return undefined;
  const lines = comments.map((c) => {
    const author = c.author?.login ?? "unknown";
    const when = c.createdAt ? ` (${c.createdAt})` : "";
    return `${author}${when}:\n${c.body ?? ""}`;
  });
  return `--- Comments ---\n${lines.join("\n\n")}`;
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
        const jsonFields = opts.includeComments ? "number,title,body,url,comments" : "number,title,body,url";
        const { stdout } = await execa("gh", ["issue", "view", number, "--repo", repo, "--json", jsonFields]);
        const issue = JSON.parse(stdout) as {
          number: number;
          title: string;
          body: string;
          url: string;
          comments?: GithubComment[];
        };
        const repoPath = repo === opts.defaultRepo ? opts.defaultRepoPath : undefined;
        const body = [issue.body, opts.includeComments ? formatComments(issue.comments) : undefined]
          .filter(Boolean)
          .join("\n\n");
        tickets.push({
          source: "github",
          externalId: String(issue.number),
          externalUrl: issue.url,
          title: issue.title,
          body: body || undefined,
          repoId: repo,
          repoPath: repoPath ?? repo,
        });
      }

      if (opts.includeAssignedToMe) {
        if (!opts.defaultRepo) {
          throw new Error("githubTicketSource: includeAssignedToMe requires defaultRepo to be set.");
        }
        const jsonFields = opts.includeComments ? "number,title,body,url,comments" : "number,title,body,url";
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
          jsonFields,
        ]);
        const mine = JSON.parse(stdout) as {
          number: number;
          title: string;
          body: string;
          url: string;
          comments?: GithubComment[];
        }[];
        for (const issue of mine) {
          const key = `${opts.defaultRepo}#${issue.number}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const body = [issue.body, opts.includeComments ? formatComments(issue.comments) : undefined]
            .filter(Boolean)
            .join("\n\n");
          tickets.push({
            source: "github",
            externalId: String(issue.number),
            externalUrl: issue.url,
            title: issue.title,
            body: body || undefined,
            repoId: opts.defaultRepo,
            repoPath: opts.defaultRepoPath ?? opts.defaultRepo,
          });
        }
      }

      return tickets;
    },
  };
}
