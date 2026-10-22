import { z } from "zod";
import type { BoardSync, BoardTarget } from "./tickets/board-status.js";

export const TicketSourceKind = z.enum([
  "github",
  "markdown",
  "notion",
  "linear",
  "jira",
]);
export type TicketSourceKind = z.infer<typeof TicketSourceKind>;

export const AgentRuntimeKind = z.enum(["claude", "copilot", "codex", "opencode"]);
export type AgentRuntimeKind = z.infer<typeof AgentRuntimeKind>;

/** A ticket normalized from any source (GitHub issue, Notion row, plain text line, ...). */
export interface NormalizedTicket {
  /** Stable id within its source, e.g. GitHub issue number, Notion page id. */
  externalId: string;
  externalUrl?: string;
  title: string;
  body?: string;
  source: TicketSourceKind;
  /** repoId as "owner/repo" or a local path-derived id for non-GitHub repos. */
  repoId: string;
  repoPath: string;
  baseRef?: string;
  /** Local profile alias when this ticket was explicitly routed to a repo. */
  repoAlias?: string;
  /** Stable repo-specific unit id; the ticket id remains the shared parent id. */
  unitId?: string;
  /** externalIds of other tickets in the same batch this one depends on. */
  dependsOn?: string[];
  /** Where to move this ticket on its board, for sources that support it. */
  boardTarget?: BoardTarget;
}

export interface TicketSource {
  kind: TicketSourceKind;
  /** Resolve raw user input (issue refs, a markdown block, a query) into normalized tickets. */
  resolve(input: string): Promise<NormalizedTicket[]>;
}

export interface PlannedTicket extends NormalizedTicket {
  id: string;
  unitId: string;
  branch: string;
  worktreePath: string;
  agent: AgentRuntimeKind;
  conflictsWith: string[];
  /** Board-status sync config, set only when status names were configured. */
  boardSync?: BoardSync;
  /** How the branch prefix was chosen, and which prefixes the agent may switch to. */
  branchNaming?: BranchNaming;
  /** Other approved repo units for this parent ticket. */
  coordinationUnits?: {
    unitId: string;
    alias: string;
    repoId: string;
    repoPath: string;
    baseRef: string;
    branch: string;
    worktreePath: string;
    branchNaming?: BranchNaming;
  }[];
  /** Shared container cwd for a catalog-scoped, multi-repository session. */
  workspacePath?: string;
}

export interface BranchNaming {
  prefix: string;
  reason: string;
  /** Where the allowed prefixes came from (a rules file path, repo detection, or built-in). */
  origin: string;
  options: { prefix: string; description: string }[];
  /** True when the user forced the prefix (--branch-prefix); the agent must not rename it. */
  locked: boolean;
}

export interface RepoCatalogEntry {
  alias: string;
  repoId: string;
  repoPath: string;
  base: string;
}

export interface ExecutionPlan {
  runId: string;
  tickets: PlannedTicket[];
  /** Tickets whose catalog repo worktrees are prepared together in one session. */
  multiRepoTicketIds?: string[];
}
