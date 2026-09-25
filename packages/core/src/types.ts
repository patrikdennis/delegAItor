import { z } from "zod";

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
  /** externalIds of other tickets in the same batch this one depends on. */
  dependsOn?: string[];
}

export interface TicketSource {
  kind: TicketSourceKind;
  /** Resolve raw user input (issue refs, a markdown block, a query) into normalized tickets. */
  resolve(input: string): Promise<NormalizedTicket[]>;
}

export interface PlannedTicket extends NormalizedTicket {
  id: string;
  branch: string;
  worktreePath: string;
  agent: AgentRuntimeKind;
  conflictsWith: string[];
}

export interface ExecutionPlan {
  runId: string;
  tickets: PlannedTicket[];
}
