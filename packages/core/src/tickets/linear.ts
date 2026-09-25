import type { NormalizedTicket, TicketSource } from "../types.js";
import { parseWantedLines } from "./util.js";

export interface LinearSourceOptions {
  /** Defaults to process.env.LINEAR_API_KEY. Personal API keys go directly
   * in the Authorization header with no "Bearer" prefix (per Linear's API
   * docs — this has not been exercised against a live Linear account in
   * this codebase, so treat as unverified until you've tried it). */
  apiKey?: string;
  defaultRepoId: string;
  defaultRepoPath: string;
  /** Restrict to a specific team, e.g. "ENG". Omit to search across all teams you belong to. */
  teamKey?: string;
  /**
   * Like the other shared-board sources: defaults to true so a shared
   * Linear workspace doesn't dispatch teammates' issues. `--all` (mapped to
   * false) pulls every non-done issue in scope instead.
   */
  onlyAssignedToMe?: boolean;
  /**
   * Restrict to specific workflow state names (e.g. ["Backlog", "Todo"]),
   * exactly as they appear in your team's board — Linear lets every team
   * rename/reorder its states, so there's no fixed "ready" set. When
   * omitted, falls back to the built-in default of any non-completed,
   * non-canceled state (state *type*, not name).
   */
  stateNames?: string[];
  /** Override for testing against a local mock server instead of api.linear.app. */
  apiUrl?: string;
}

const QUERY = /* GraphQL */ `
  query DelegaitorIssues($filter: IssueFilter) {
    issues(filter: $filter, first: 100) {
      nodes {
        id
        identifier
        title
        description
        url
      }
    }
  }
`;

/**
 * Pulls open issues from Linear via its GraphQL API. Defaults to "assigned
 * to me" scoping; pass `onlyAssignedToMe: false` (typically via a `--all`
 * flag) to pull every open issue in scope instead, or list explicit issue
 * identifiers/titles in the input text to bypass filtering entirely.
 */
export function linearTicketSource(opts: LinearSourceOptions): TicketSource {
  const apiKey = opts.apiKey ?? process.env.LINEAR_API_KEY;
  const apiUrl = opts.apiUrl ?? "https://api.linear.app/graphql";

  return {
    kind: "linear",
    async resolve(input: string): Promise<NormalizedTicket[]> {
      if (!apiKey) {
        throw new Error("linearTicketSource: no API key. Set LINEAR_API_KEY or pass apiKey.");
      }

      const wanted = parseWantedLines(input);
      const explicitSelection = wanted.length > 0;
      const onlyAssignedToMe = opts.onlyAssignedToMe ?? true;

      const filter: Record<string, unknown> = opts.stateNames?.length
        ? { state: { name: { in: opts.stateNames } } }
        : { state: { type: { nin: ["completed", "canceled"] } } };
      if (opts.teamKey) {
        filter.team = { key: { eq: opts.teamKey } };
      }
      if (!explicitSelection && onlyAssignedToMe) {
        filter.assignee = { isMe: { eq: true } };
      }

      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: QUERY, variables: { filter } }),
      });
      if (!res.ok) {
        throw new Error(`Linear query failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as {
        errors?: { message: string }[];
        data?: { issues: { nodes: LinearIssue[] } };
      };
      if (data.errors?.length) {
        throw new Error(`Linear query failed: ${data.errors.map((e) => e.message).join("; ")}`);
      }
      const nodes = data.data?.issues.nodes ?? [];

      const tickets: NormalizedTicket[] = [];
      for (const issue of nodes) {
        if (
          explicitSelection &&
          !wanted.some((w) => issue.title.includes(w) || issue.identifier === w || issue.id === w)
        ) {
          continue;
        }
        tickets.push({
          source: "linear",
          externalId: issue.identifier,
          externalUrl: issue.url,
          title: issue.title,
          body: issue.description ?? undefined,
          repoId: opts.defaultRepoId,
          repoPath: opts.defaultRepoPath,
        });
      }
      return tickets;
    },
  };
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
}
