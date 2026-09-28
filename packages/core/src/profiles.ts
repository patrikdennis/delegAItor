import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { join } from "node:path";
import { delegaitorHome } from "./paths.js";
import type { AgentRuntimeKind } from "./types.js";
import type { ResolveExecutionPlanOptions } from "./resolve.js";

/**
 * A saved set of plan/dispatch options, so "delegate my Sales Engine
 * tickets" doesn't need a dozen flags. Field names match the MCP tool
 * inputs. Everything is optional: whatever is set on the command line or
 * in the tool call overrides the profile.
 */
export interface DispatchProfile {
  description?: string;
  agent?: AgentRuntimeKind;
  repo?: string;
  repoPath?: string;
  base?: string;
  branchPrefix?: string;
  branchRules?: string;
  all?: boolean;
  githubMine?: boolean;
  githubComments?: boolean;
  notionDatabaseId?: string;
  notionAssigneeId?: string;
  notionStatuses?: string[];
  notionTitleProp?: string;
  notionStatusProp?: string;
  notionBodyProp?: string;
  notionProjectProp?: string;
  notionProjects?: string[];
  notionIncludePageContent?: boolean;
  linear?: boolean;
  linearTeamKey?: string;
  linearStatuses?: string[];
  jiraProject?: string;
  jiraJql?: string;
  jiraStatuses?: string[];
  boardStatuses?: { in_progress?: string; ready_for_review?: string; blocked?: string; done?: string };
}

const PROFILE_KEYS = new Set<keyof DispatchProfile>([
  "description", "agent", "repo", "repoPath", "base", "branchPrefix", "branchRules", "all", "githubMine",
  "githubComments", "notionDatabaseId", "notionAssigneeId", "notionStatuses", "notionTitleProp",
  "notionStatusProp", "notionBodyProp", "notionProjectProp", "notionProjects", "notionIncludePageContent",
  "linear", "linearTeamKey", "linearStatuses", "jiraProject", "jiraJql", "jiraStatuses", "boardStatuses",
]);

export function profilesPath(): string {
  return join(delegaitorHome(), "profiles.json");
}

function readAll(): Record<string, DispatchProfile> {
  const path = profilesPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, DispatchProfile>;
  } catch (e) {
    throw new Error(`Couldn't parse ${path}: ${(e as Error).message}`);
  }
}

function writeAll(all: Record<string, DispatchProfile>): void {
  writeFileSync(profilesPath(), JSON.stringify(all, null, 2) + "\n", "utf8");
}

export function listProfiles(): Record<string, DispatchProfile> {
  return readAll();
}

export function getProfile(name: string): DispatchProfile {
  const all = readAll();
  const p = all[name];
  if (!p) {
    const names = Object.keys(all);
    throw new Error(
      `No profile named "${name}". ` +
        (names.length ? `Saved profiles: ${names.join(", ")}.` : "No profiles saved yet; create one with `delegaitor profile save`."),
    );
  }
  return p;
}

/** Drops undefined values and unknown keys, so merging only overrides what was actually given. */
export function cleanProfile(p: Record<string, unknown>): DispatchProfile {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || !PROFILE_KEYS.has(k as keyof DispatchProfile)) continue;
    if (k === "boardStatuses" && v && typeof v === "object") {
      const b = Object.fromEntries(Object.entries(v).filter(([, s]) => s !== undefined && s !== ""));
      if (Object.keys(b).length) out[k] = b;
      continue;
    }
    out[k] = v;
  }
  return out as DispatchProfile;
}

/** `overrides` wins field by field; board statuses merge per stage. */
export function mergeProfile(base: DispatchProfile, overrides: DispatchProfile): DispatchProfile {
  const o = cleanProfile(overrides as Record<string, unknown>);
  const merged = { ...base, ...o };
  if (base.boardStatuses || o.boardStatuses) merged.boardStatuses = { ...base.boardStatuses, ...o.boardStatuses };
  return merged;
}

/**
 * Saves (or, with `merge`, updates) a profile. A relative repoPath is
 * stored as absolute, and a repo without a path gets the current directory,
 * so the profile works when dispatched from anywhere later.
 */
export function saveProfile(name: string, profile: DispatchProfile, opts: { merge?: boolean; cwd?: string } = {}): DispatchProfile {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`Profile names may only contain letters, digits, ".", "_" and "-" (got "${name}").`);
  const all = readAll();
  let p = cleanProfile(profile as Record<string, unknown>);
  if (opts.merge && all[name]) p = mergeProfile(all[name], p);
  const cwd = opts.cwd ?? process.cwd();
  if (p.repoPath) p.repoPath = isAbsolute(p.repoPath) ? p.repoPath : resolve(cwd, p.repoPath);
  else if (p.repo) p.repoPath = cwd;
  all[name] = p;
  writeAll(all);
  return p;
}

export function removeProfile(name: string): boolean {
  const all = readAll();
  if (!all[name]) return false;
  delete all[name];
  writeAll(all);
  return true;
}

/** Maps a profile (usually a saved one merged with overrides) onto resolveExecutionPlan's options. */
export function profileToResolveOptions(p: DispatchProfile): ResolveExecutionPlanOptions {
  const hasNotionProps = p.notionTitleProp || p.notionStatusProp || p.notionBodyProp || p.notionProjectProp;
  return {
    defaultAgent: p.agent ?? "claude",
    repo: p.repo,
    repoPath: p.repoPath,
    base: p.base,
    branchPrefix: p.branchPrefix,
    branchRulesFile: p.branchRules,
    all: p.all,
    github: { mine: p.githubMine, comments: p.githubComments },
    notion: p.notionDatabaseId
      ? {
          databaseId: p.notionDatabaseId,
          assigneeUserId: p.notionAssigneeId,
          readyStatuses: p.notionStatuses,
          projects: p.notionProjects,
          properties: hasNotionProps
            ? { title: p.notionTitleProp, status: p.notionStatusProp, body: p.notionBodyProp, project: p.notionProjectProp }
            : undefined,
          includePageContent: p.notionIncludePageContent ?? true,
        }
      : undefined,
    linear: p.linear ? { teamKey: p.linearTeamKey, stateNames: p.linearStatuses } : undefined,
    jira:
      p.jiraProject || p.jiraJql ? { project: p.jiraProject, jql: p.jiraJql, statuses: p.jiraStatuses } : undefined,
    boardStatuses: p.boardStatuses,
  };
}

/** True when the profile pulls from a board/issue source, so no ticket text is needed. */
export function profileHasTicketSource(p: DispatchProfile): boolean {
  return !!(p.notionDatabaseId || p.linear || p.jiraProject || p.jiraJql || p.githubMine);
}
