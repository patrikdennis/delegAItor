import type { NormalizedTicket, TicketSource } from "../types.js";
import { parseWantedLines } from "./util.js";

export interface JiraSourceOptions {
  /** e.g. "https://your-domain.atlassian.net" */
  baseUrl?: string; // defaults to process.env.JIRA_BASE_URL
  /** Account email used for Basic auth. Defaults to process.env.JIRA_EMAIL. */
  email?: string;
  /** API token (not your password). Defaults to process.env.JIRA_API_TOKEN. */
  apiToken?: string;
  defaultRepoId: string;
  defaultRepoPath: string;
  /**
   * Defaults to true: only your own assigned, not-Done issues. Set to
   * false (typically via `--all`) to search the whole project instead —
   * when doing so `project` becomes required, so an `--all` run can't
   * accidentally scan the entire Jira instance.
   */
  onlyAssignedToMe?: boolean;
  /** Jira project key, e.g. "ENG". Required when onlyAssignedToMe is false. */
  project?: string;
  /**
   * Restrict to specific status names (e.g. ["Backlog", "Selected for
   * Development"]), exactly as they appear on your board — Jira workflows
   * are fully custom per-project, so there's no fixed "ready" set. When
   * omitted, falls back to the built-in default of `statusCategory !=
   * Done`. Ignored if a custom `jql` is supplied.
   */
  statuses?: string[];
  /** Full custom JQL; overrides the built-in default/mine query entirely. */
  jql?: string;
}

/**
 * Pulls issues from Jira Cloud's REST v3 search API. Defaults to
 * `assignee = currentUser() AND statusCategory != Done` so a shared
 * project board doesn't dispatch other people's tickets; pass a `project`
 * with `onlyAssignedToMe: false` to search a whole project instead, a
 * custom `jql`, or list explicit issue keys/titles in the input to bypass
 * filtering.
 */
export function jiraTicketSource(opts: JiraSourceOptions): TicketSource {
  const baseUrl = opts.baseUrl ?? process.env.JIRA_BASE_URL;
  const email = opts.email ?? process.env.JIRA_EMAIL;
  const apiToken = opts.apiToken ?? process.env.JIRA_API_TOKEN;

  return {
    kind: "jira",
    async resolve(input: string): Promise<NormalizedTicket[]> {
      if (!baseUrl || !email || !apiToken) {
        throw new Error(
          "jiraTicketSource: missing config. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN (or pass them explicitly).",
        );
      }

      const wanted = parseWantedLines(input);
      const explicitSelection = wanted.length > 0;
      const onlyAssignedToMe = opts.onlyAssignedToMe ?? true;

      let jql = opts.jql;
      if (!jql) {
        if (!onlyAssignedToMe && !opts.project) {
          throw new Error(
            "jiraTicketSource: onlyAssignedToMe=false requires a project key, to avoid searching the entire Jira instance.",
          );
        }
        const clauses: string[] = [];
        if (opts.project) clauses.push(`project = "${opts.project}"`);
        if (onlyAssignedToMe) clauses.push("assignee = currentUser()");
        if (opts.statuses?.length) {
          clauses.push(`status IN (${opts.statuses.map((s) => `"${s}"`).join(", ")})`);
        } else {
          clauses.push("statusCategory != Done");
        }
        jql = clauses.join(" AND ");
      }

      const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
      const res = await fetch(`${baseUrl}/rest/api/3/search`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jql,
          maxResults: 100,
          fields: ["summary", "description"],
        }),
      });
      if (!res.ok) {
        throw new Error(`Jira search failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as { issues: JiraIssue[] };

      const tickets: NormalizedTicket[] = [];
      for (const issue of data.issues) {
        const title = issue.fields.summary;
        if (explicitSelection && !wanted.some((w) => title.includes(w) || issue.key === w)) {
          continue;
        }
        tickets.push({
          source: "jira",
          externalId: issue.key,
          externalUrl: `${baseUrl}/browse/${issue.key}`,
          title,
          body: adfToPlainText(issue.fields.description),
          repoId: opts.defaultRepoId,
          repoPath: opts.defaultRepoPath,
        });
      }
      return tickets;
    },
  };
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: AdfNode | null;
  };
}

/** Atlassian Document Format node — Jira Cloud's rich-text description shape. */
interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}

/** Recursively flattens an ADF description document into plain text. */
function adfToPlainText(doc: AdfNode | null | undefined): string | undefined {
  if (!doc) return undefined;
  const lines: string[] = [];
  let current = "";

  function walk(node: AdfNode): void {
    if (node.type === "text" && node.text) {
      current += node.text;
      return;
    }
    if (node.content) {
      for (const child of node.content) walk(child);
    }
    if (node.type === "paragraph" || node.type === "heading" || node.type === "hardBreak") {
      lines.push(current);
      current = "";
    }
  }

  walk(doc);
  if (current) lines.push(current);
  const text = lines.join("\n").trim();
  return text || undefined;
}
