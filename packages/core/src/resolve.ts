import { execa } from "execa";
import type { AgentRuntimeKind, ExecutionPlan, NormalizedTicket } from "./types.js";
import { buildPlan } from "./planner.js";
import {
  githubTicketSource,
  markdownTicketSource,
  notionTicketSource,
  linearTicketSource,
  jiraTicketSource,
  type GithubSourceOptions,
  type NotionSourceOptions,
  type LinearSourceOptions,
  type JiraSourceOptions,
} from "./tickets/index.js";

export interface ResolveExecutionPlanOptions {
  defaultAgent: AgentRuntimeKind;
  agentOverrides?: Record<string, AgentRuntimeKind>;
  repo?: string;
  repoPath?: string;
  base?: string;
  /**
   * Shared "not all tickets are ours" switch for shared boards
   * (Notion/Linear/Jira): when false (the default), each of those sources
   * is scoped to "assigned to me". Pass true (typically via a `--all`
   * CLI/MCP flag) to pull every open/ready ticket in scope instead.
   * Listing explicit ticket titles/ids/URLs in the input text always
   * overrides this, for either value.
   */
  all?: boolean;
  github?: {
    /** Also pull open GitHub issues assigned to you in `repo`, not just explicit "#123" refs. */
    mine?: boolean;
    /** Also fetch each issue's comment thread as extra ticket context. Defaults to false. */
    comments?: boolean;
  };
  notion?: Pick<
    NotionSourceOptions,
    | "databaseId"
    | "properties"
    | "readyStatuses"
    | "projects"
    | "apiKey"
    | "apiBaseUrl"
    | "assigneeUserId"
    | "includePageContent"
  >;
  linear?: Pick<LinearSourceOptions, "apiKey" | "teamKey" | "apiUrl" | "stateNames">;
  jira?: Pick<JiraSourceOptions, "baseUrl" | "email" | "apiToken" | "project" | "jql" | "statuses">;
}

/**
 * The single place that turns free-form ticket text plus source config
 * into a concrete ExecutionPlan. Both the CLI and the MCP server call this
 * so ticket-source construction, dedup, and plan-building never drift
 * between the two front-ends.
 */
export async function resolveExecutionPlan(
  input: string,
  opts: ResolveExecutionPlanOptions,
): Promise<ExecutionPlan> {
  const repoPath = opts.repoPath ?? process.cwd();
  const repoId = opts.repo ?? (await inferRepoId(repoPath));
  const all = opts.all ?? false;

  const githubOpts: GithubSourceOptions = {
    defaultRepo: repoId,
    defaultRepoPath: repoPath,
    includeAssignedToMe: opts.github?.mine ?? false,
    includeComments: opts.github?.comments ?? false,
  };
  const sources = [
    githubTicketSource(githubOpts),
    markdownTicketSource({ defaultRepoId: repoId, defaultRepoPath: repoPath, defaultBaseRef: opts.base }),
  ];

  if (opts.notion) {
    sources.push(
      notionTicketSource({
        ...opts.notion,
        defaultRepoId: repoId,
        defaultRepoPath: repoPath,
        onlyAssignedToMe: !all,
      }),
    );
  }
  if (opts.linear) {
    sources.push(
      linearTicketSource({
        ...opts.linear,
        defaultRepoId: repoId,
        defaultRepoPath: repoPath,
        onlyAssignedToMe: !all,
      }),
    );
  }
  if (opts.jira) {
    sources.push(
      jiraTicketSource({
        ...opts.jira,
        defaultRepoId: repoId,
        defaultRepoPath: repoPath,
        onlyAssignedToMe: !all,
      }),
    );
  }

  const resolved: NormalizedTicket[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const t of await source.resolve(input)) {
      const key = `${t.source}:${t.externalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push(t);
    }
  }

  return buildPlan(resolved, { defaultAgent: opts.defaultAgent, agentOverrides: opts.agentOverrides });
}

async function inferRepoId(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execa("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd: repoPath,
    });
    if (stdout.trim()) return stdout.trim();
  } catch {
    /* not a GitHub repo or gh unavailable; fall back to directory name */
  }
  return repoPath.split("/").filter(Boolean).pop() ?? "unknown-repo";
}
