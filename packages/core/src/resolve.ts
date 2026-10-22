import { execa } from "execa";
import { isAbsolute } from "node:path";
import type { AgentRuntimeKind, ExecutionPlan, NormalizedTicket, RepoCatalogEntry } from "./types.js";
import { buildPlan } from "./planner.js";
import { loadBranchPrefixRules, type BranchPrefixRules } from "./worktree/branch-prefix.js";
import { sanitize } from "./paths.js";
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
  type BoardStatusMap,
} from "./tickets/index.js";

export interface ResolveExecutionPlanOptions {
  defaultAgent: AgentRuntimeKind;
  agentOverrides?: Record<string, AgentRuntimeKind>;
  repo?: string;
  repoPath?: string;
  base?: string;
  /**
   * Forces this prefix on every branch (e.g. "fix/", or "" for none). When
   * omitted, each ticket gets a prefix picked from the repo's branch prefix
   * rules (see loadBranchPrefixRules).
   */
  branchPrefix?: string;
  /** Path to a branch-prefixes.json file, overriding the repo/home lookup. */
  branchRulesFile?: string;
  /** Local catalog is the allowed repo scope; every entry gets an isolated worktree. */
  repoCatalog?: RepoCatalogEntry[];
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
  /**
   * Board status names to move tickets to at each point of their
   * lifecycle, exactly as they appear on the board (e.g.
   * `{ in_progress: "In progress", ready_for_review: "Ready for review" }`).
   * Only applies to sources that support it (Notion, Linear, Jira); points
   * without a name are left alone.
   */
  boardStatuses?: BoardStatusMap;
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
  const repoPath = opts.repoPath ?? opts.repoCatalog?.[0]?.repoPath ?? process.cwd();
  const repoId = opts.repo ?? opts.repoCatalog?.[0]?.repoId ?? (await inferRepoId(repoPath));
  const all = opts.all ?? false;
  validateRepoCatalog(opts.repoCatalog);
  if (opts.repoCatalog?.length && (opts.repo || opts.repoPath)) {
    throw new Error("A repository catalog cannot be combined with single-repository repo/repoPath settings.");
  }

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

  let routed = resolved;
  if (opts.repoCatalog?.length) {
    routed = [];
    for (const ticket of resolved) {
      const id = sanitize(ticket.externalId);
      if (new Set(opts.repoCatalog.map((entry) => entry.repoId)).size !== opts.repoCatalog.length) {
        throw new Error("A repository catalog cannot contain multiple aliases for the same repo id.");
      }
      for (const entry of opts.repoCatalog) {
        routed.push({
          ...ticket,
          repoAlias: entry.alias,
          repoId: entry.repoId,
          repoPath: entry.repoPath,
          baseRef: entry.base,
          unitId: `${id}--${sanitize(entry.alias)}`,
        });
      }
    }
  }

  const branchRules = new Map<string, BranchPrefixRules>();
  for (const path of new Set(routed.map((t) => t.repoPath))) {
    branchRules.set(path, await loadBranchPrefixRules(path, opts.branchRulesFile));
  }

  const plan = buildPlan(routed, {
    defaultAgent: opts.defaultAgent,
    agentOverrides: opts.agentOverrides,
    branchPrefix: opts.branchPrefix,
    branchRules,
  });
  if (opts.repoCatalog?.length) {
    const counts = new Map<string, number>();
    for (const ticket of plan.tickets) counts.set(ticket.id, (counts.get(ticket.id) ?? 0) + 1);
    const multiRepoTicketIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
    if (multiRepoTicketIds.length) plan.multiRepoTicketIds = multiRepoTicketIds;
  }
  const statuses = Object.fromEntries(
    Object.entries(opts.boardStatuses ?? {}).filter(([, name]) => !!name?.trim()),
  ) as BoardStatusMap;
  if (Object.keys(statuses).length) {
    for (const t of plan.tickets) {
      if (t.boardTarget) t.boardSync = { target: t.boardTarget, statuses };
    }
  }
  return plan;
}

function validateRepoCatalog(catalog?: RepoCatalogEntry[]): void {
  if (!catalog?.length) return;
  const aliases = new Set<string>();
  for (const entry of catalog) {
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(entry.alias)) {
      throw new Error(`Invalid repository alias "${entry.alias}". Use 1 to 24 letters, digits, "_" or "-".`);
    }
    if (aliases.has(entry.alias)) throw new Error(`Duplicate repository alias "${entry.alias}" in the active profile.`);
    aliases.add(entry.alias);
    if (!entry.repoId.trim()) throw new Error(`Repository "${entry.alias}" needs a repo id (owner/repo).`);
    if (!isAbsolute(entry.repoPath)) {
      throw new Error(`Repository "${entry.alias}" needs an absolute repoPath; save its local clone path in the profile.`);
    }
    if (!entry.base.trim()) throw new Error(`Repository "${entry.alias}" needs an explicit base branch.`);
  }
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
