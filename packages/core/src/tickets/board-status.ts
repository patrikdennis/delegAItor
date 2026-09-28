import { getDb } from "../db.js";
import { getCredential } from "../credentials.js";

/**
 * The points in a delegated ticket's life where delegAItor can move the
 * source ticket on its board. Board columns are named differently on every
 * team/tool ("In progress" vs "Doing" vs "In Development"...), so each of
 * these is mapped to the literal status name via config — nothing is moved
 * unless a name has been configured for that point.
 */
export const BOARD_LIFECYCLE = ["in_progress", "ready_for_review", "blocked", "done"] as const;
export type BoardLifecycle = (typeof BOARD_LIFECYCLE)[number];
export type BoardStatusMap = Partial<Record<BoardLifecycle, string>>;

/**
 * Where a ticket lives, recorded at resolve time by its source adapter so
 * that a later, separate process (e.g. the MCP server inside an agent
 * session calling delegaitor_session_complete) can move it without
 * knowing the original CLI flags. Never contains credentials.
 */
export type BoardTarget =
  | { source: "notion"; databaseId: string; statusProperty: string; apiBaseUrl?: string }
  | { source: "linear"; apiUrl?: string }
  | { source: "jira"; baseUrl?: string };

export interface BoardSync {
  target: BoardTarget;
  statuses: BoardStatusMap;
}

export interface BoardStatusResult {
  lifecycle: BoardLifecycle;
  status: string;
  ok: boolean;
  error?: string;
}

export function isBoardLifecycle(value: string): value is BoardLifecycle {
  return (BOARD_LIFECYCLE as readonly string[]).includes(value);
}

/**
 * Moves a persisted ticket to the board status configured for `lifecycle`.
 * Returns undefined when there's nothing to do (ticket source can't be
 * moved, or no status name is configured for this point). Never throws:
 * a failed board update must not fail a dispatch or a session completion,
 * so errors are returned for the caller to surface instead.
 */
export async function syncBoardStatus(
  ticketId: string,
  lifecycle: BoardLifecycle,
): Promise<BoardStatusResult | undefined> {
  const row = getDb()
    .prepare(`SELECT external_id as externalId, board_sync_json as boardSyncJson FROM tickets WHERE id = ?`)
    .get(ticketId) as { externalId: string; boardSyncJson: string | null } | undefined;
  if (!row?.boardSyncJson) return undefined;

  const sync = JSON.parse(row.boardSyncJson) as BoardSync;
  const status = sync.statuses[lifecycle];
  if (!status) return undefined;

  try {
    await moveOnBoard(sync.target, row.externalId, status);
    return { lifecycle, status, ok: true };
  } catch (err) {
    return { lifecycle, status, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function moveOnBoard(target: BoardTarget, externalId: string, status: string): Promise<void> {
  switch (target.source) {
    case "notion":
      return moveNotion(target, externalId, status);
    case "linear":
      return moveLinear(target, externalId, status);
    case "jira":
      return moveJira(target, externalId, status);
  }
}

const NOTION_VERSION = "2022-06-28";

async function moveNotion(
  target: Extract<BoardTarget, { source: "notion" }>,
  pageId: string,
  status: string,
): Promise<void> {
  const apiKey = getCredential("NOTION_API_KEY");
  if (!apiKey) throw new Error("No Notion credentials (set NOTION_API_KEY or run `delegaitor auth set NOTION_API_KEY`).");
  const base = target.apiBaseUrl ?? "https://api.notion.com";
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  // Check the name against the database's real options first: writing an
  // unknown name to a `select` property would silently create a new column.
  const dbRes = await fetch(`${base}/v1/databases/${target.databaseId}`, { headers });
  if (!dbRes.ok) throw new Error(`Notion database lookup failed: ${dbRes.status} ${await dbRes.text()}`);
  const db = (await dbRes.json()) as {
    properties: Record<string, { type: string; status?: { options: { name: string }[] }; select?: { options: { name: string }[] } }>;
  };
  const prop = db.properties[target.statusProperty];
  if (!prop) {
    throw new Error(
      `Notion database has no "${target.statusProperty}" property (available: ${Object.keys(db.properties).join(", ")}). ` +
        "Set --notion-status-prop to the name of your status column.",
    );
  }
  if (prop.type !== "status" && prop.type !== "select") {
    throw new Error(`Notion property "${target.statusProperty}" is a ${prop.type}, expected a status or select property.`);
  }
  const options = (prop.type === "status" ? prop.status?.options : prop.select?.options) ?? [];
  const match = options.find((o) => o.name.toLowerCase() === status.toLowerCase());
  if (!match) {
    throw new Error(
      `"${status}" is not an option of Notion property "${target.statusProperty}". ` +
        `Valid options: ${options.map((o) => `"${o.name}"`).join(", ")}.`,
    );
  }

  const res = await fetch(`${base}/v1/pages/${pageId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ properties: { [target.statusProperty]: { [prop.type]: { name: match.name } } } }),
  });
  if (!res.ok) throw new Error(`Notion page update failed: ${res.status} ${await res.text()}`);
}

async function moveLinear(
  target: Extract<BoardTarget, { source: "linear" }>,
  identifier: string,
  status: string,
): Promise<void> {
  const apiKey = getCredential("LINEAR_API_KEY");
  if (!apiKey) throw new Error("No Linear credentials (set LINEAR_API_KEY or run `delegaitor auth set LINEAR_API_KEY`).");
  const url = target.apiUrl ?? "https://api.linear.app/graphql";

  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Linear request failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (data.errors?.length) throw new Error(`Linear request failed: ${data.errors.map((e) => e.message).join("; ")}`);
    return data.data as T;
  };

  // Workflow states are per team, so look them up on the issue's own team.
  const found = await gql<{ issue: { id: string; team: { states: { nodes: { id: string; name: string }[] } } } }>(
    `query($id: String!) { issue(id: $id) { id team { states { nodes { id name } } } } }`,
    { id: identifier },
  );
  const states = found.issue.team.states.nodes;
  const state = states.find((s) => s.name.toLowerCase() === status.toLowerCase());
  if (!state) {
    throw new Error(`"${status}" is not a workflow state on this Linear team. Valid states: ${states.map((s) => `"${s.name}"`).join(", ")}.`);
  }
  const updated = await gql<{ issueUpdate: { success: boolean } }>(
    `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
    { id: found.issue.id, stateId: state.id },
  );
  if (!updated.issueUpdate.success) throw new Error("Linear issueUpdate reported success=false.");
}

async function moveJira(
  target: Extract<BoardTarget, { source: "jira" }>,
  key: string,
  status: string,
): Promise<void> {
  const baseUrl = target.baseUrl ?? getCredential("JIRA_BASE_URL");
  const email = getCredential("JIRA_EMAIL");
  const token = getCredential("JIRA_API_TOKEN");
  if (!baseUrl || !email || !token) {
    throw new Error("Missing Jira credentials (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN; env or `delegaitor auth set`).");
  }
  const headers = {
    Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Jira can't set a status directly; it must go through a workflow
  // transition that is valid from the issue's current status.
  const res = await fetch(`${baseUrl}/rest/api/3/issue/${key}/transitions`, { headers });
  if (!res.ok) throw new Error(`Jira transitions lookup failed: ${res.status} ${await res.text()}`);
  const { transitions } = (await res.json()) as { transitions: { id: string; name: string; to: { name: string } }[] };
  const wanted = status.toLowerCase();
  const transition =
    transitions.find((t) => t.to.name.toLowerCase() === wanted) ?? transitions.find((t) => t.name.toLowerCase() === wanted);
  if (!transition) {
    throw new Error(
      `No Jira transition from this issue's current status to "${status}". ` +
        `Reachable: ${transitions.map((t) => `"${t.to.name}"`).join(", ") || "(none)"}.`,
    );
  }
  const post = await fetch(`${baseUrl}/rest/api/3/issue/${key}/transitions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ transition: { id: transition.id } }),
  });
  if (!post.ok) throw new Error(`Jira transition failed: ${post.status} ${await post.text()}`);
}
