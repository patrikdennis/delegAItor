import { randomUUID } from "node:crypto";
import type { AgentRuntimeKind, ExecutionPlan, NormalizedTicket, PlannedTicket } from "./types.js";
import { branchName, detectLikelyConflicts } from "./worktree/git.js";
import { repoWorktreesDir, sanitize } from "./paths.js";
import { join } from "node:path";
import { classifyBranchPrefix, type BranchPrefixRules } from "./worktree/branch-prefix.js";

export interface PlanOptions {
  defaultAgent: AgentRuntimeKind;
  /** Override agent per externalId, e.g. from user input like "#1234=claude". */
  agentOverrides?: Record<string, AgentRuntimeKind>;
  /** Forces this prefix on every branch (e.g. "fix/", or "" for none) instead of classifying each ticket. */
  branchPrefix?: string;
  /** Branch prefix rules per repoPath, used to classify each ticket when branchPrefix isn't forced. */
  branchRules?: Map<string, BranchPrefixRules>;
}

/**
 * Turns normalized tickets (from any source) into a concrete execution
 * plan: stable ids, branch names, worktree paths, assigned agent runtime,
 * and flagged same-repo conflicts — all before any git or process side
 * effects happen, so it can be reviewed/confirmed first.
 */
export function buildPlan(tickets: NormalizedTicket[], opts: PlanOptions): ExecutionPlan {
  const runId = randomUUID();
  const externalToId = new Map(tickets.map((t) => [t.externalId, `${sanitize(t.externalId)}`]));

  const planned: PlannedTicket[] = tickets.map((t) => {
    const id = externalToId.get(t.externalId)!;
    const agent = opts.agentOverrides?.[t.externalId] ?? opts.defaultAgent;
    const rules = opts.branchRules?.get(t.repoPath);
    const options = rules?.prefixes.map((p) => ({ prefix: p.prefix, description: p.description })) ?? [];
    const branchNaming =
      opts.branchPrefix !== undefined
        ? { prefix: opts.branchPrefix, reason: "set with --branch-prefix", origin: rules?.origin ?? "", options, locked: true }
        : rules
          ? { ...classifyBranchPrefix(t, rules), origin: rules.origin, options, locked: false }
          : undefined;
    const branch = branchName(id, t.title, branchNaming?.prefix);
    const worktreePath = join(repoWorktreesDir(t.repoId), sanitize(id));
    return {
      ...t,
      id,
      branch,
      worktreePath,
      agent,
      baseRef: t.baseRef ?? "main",
      dependsOn: t.dependsOn?.map((dep) => externalToId.get(dep) ?? dep),
      conflictsWith: [],
      branchNaming,
    };
  });

  const conflicts = detectLikelyConflicts(planned);
  for (const t of planned) {
    t.conflictsWith = conflicts.get(t.id) ?? [];
  }

  return { runId, tickets: planned };
}
