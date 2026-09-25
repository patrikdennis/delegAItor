import type { NormalizedTicket, TicketSource } from "../types.js";
import { parseWantedLines } from "./util.js";

export interface NotionSourceOptions {
  /** Defaults to process.env.NOTION_API_KEY. */
  apiKey?: string;
  databaseId: string;
  /** Property name mapping, since Notion schemas are user-defined. */
  properties?: {
    title?: string; // default "Name"
    repo?: string; // a select/text property holding "owner/repo"
    status?: string; // a select property; only non-done items are pulled
    body?: string; // a rich_text property used as the ticket body/spec
    assignee?: string; // a "people" property; default "Assignee"
    /**
     * Property holding a human-readable project/initiative name, used to
     * scope to one project on a shared multi-project board. Boards vary a
     * lot here: a plain `select`/`status` property works directly, but a
     * `relation` to a separate Projects database only exposes an opaque
     * id — point this at a `rollup` property that surfaces the related
     * project's title instead (Notion databases often have one for
     * exactly this reason).
     */
    project?: string;
  };
  defaultRepoId: string;
  defaultRepoPath: string;
  /** Notion select value(s) considered "ready to delegate". Defaults to any non-done status. */
  readyStatuses?: string[];
  /**
   * Restrict to one or more project/initiative names (matched against
   * `properties.project`, e.g. from a rollup showing a related project's
   * title). Every workspace organizes projects differently, so there's no
   * default — omit to pull tickets from every project in the database.
   */
  projects?: string[];
  /**
   * On a shared scrum board not everything is yours. When true (the
   * default whenever an assignee property is configured/discoverable) the
   * query is scoped server-side to pages where you are in the assignee
   * "people" property. Pass `false` (typically via a CLI `--all` flag) to
   * pull the whole board instead.
   */
  onlyAssignedToMe?: boolean;
  /** Notion user id to filter by; defaults to the API key's own user (`/v1/users/me`). */
  assigneeUserId?: string;
  /**
   * By default, delegAItor also fetches each page's actual body content
   * (the paragraphs/lists/etc. written below the title/properties — the
   * same text you'd see scrolling down the page in Notion, not a database
   * property) via the block-children API, and appends it to the ticket
   * body alongside any configured `properties.body` property. Pass
   * `false` to skip this and rely solely on `properties.body` (fewer API
   * calls, useful for very large databases).
   */
  includePageContent?: boolean;
  /** Override for testing against a local mock server instead of api.notion.com. */
  apiBaseUrl?: string;
}

const NOTION_VERSION = "2022-06-28";
const MAX_PAGES = 5; // safety cap: 5 * 100 = 500 results per resolve() call

/**
 * Pulls tickets from a Notion database. Notion has no fixed ticket schema,
 * so property names are configurable; sensible defaults assume a "Name"
 * title property and an optional "Status"/"Repo"/"Spec"/"Assignee" property.
 *
 * By default, when an assignee property is available, results are
 * filtered server-side to "assigned to me" — most teams share one Notion
 * board across many people, and blindly dispatching every card on it would
 * pick up tickets that aren't yours. Explicitly naming ticket titles/ids in
 * the input, or passing `onlyAssignedToMe: false`, overrides this.
 */
export function notionTicketSource(opts: NotionSourceOptions): TicketSource {
  const apiKey = opts.apiKey ?? process.env.NOTION_API_KEY;
  const baseUrl = opts.apiBaseUrl ?? "https://api.notion.com";
  const props = {
    title: opts.properties?.title ?? "Name",
    repo: opts.properties?.repo,
    status: opts.properties?.status ?? "Status",
    body: opts.properties?.body,
    assignee: opts.properties?.assignee ?? "Assignee",
    project: opts.properties?.project,
  };

  return {
    kind: "notion",
    async resolve(input: string): Promise<NormalizedTicket[]> {
      if (!apiKey) {
        throw new Error(
          "notionTicketSource: no API key. Set NOTION_API_KEY or pass apiKey.",
        );
      }

      // `input` may name specific page titles/ids to filter to; this is an
      // explicit selection and always overrides mine-only/status filtering.
      const wanted = parseWantedLines(input);
      const explicitSelection = wanted.length > 0;

      const onlyAssignedToMe = opts.onlyAssignedToMe ?? true;
      const shouldFilterByAssignee = !explicitSelection && onlyAssignedToMe && !!props.assignee;

      let assigneeUserId = opts.assigneeUserId;
      if (shouldFilterByAssignee && !assigneeUserId) {
        assigneeUserId = await fetchCurrentUserId(baseUrl, apiKey);
      }

      const filter = buildFilter({
        assigneeProp: shouldFilterByAssignee ? props.assignee : undefined,
        assigneeUserId: shouldFilterByAssignee ? assigneeUserId : undefined,
      });

      const pages: NotionPage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await fetch(`${baseUrl}/v1/databases/${opts.databaseId}/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            page_size: 100,
            ...(filter ? { filter } : {}),
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        });
        if (!res.ok) {
          throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
        }
        const data = (await res.json()) as {
          results: NotionPage[];
          has_more: boolean;
          next_cursor: string | null;
        };
        pages.push(...data.results);
        if (!data.has_more || !data.next_cursor) break;
        cursor = data.next_cursor;
      }

      const tickets: NormalizedTicket[] = [];
      for (const p of pages) {
        // Always exclude archived/trashed pages regardless of any other
        // filter — nobody wants delegAItor picking up a soft-deleted or
        // archived card, and the query API doesn't reliably exclude these
        // once any filter clause is present.
        if (p.archived || p.in_trash) continue;
        const title = plainText(p.properties[props.title]);
        if (!title) continue;
        if (explicitSelection && !wanted.some((w) => title.includes(w) || p.id === w)) {
          continue;
        }
        if (!explicitSelection && opts.readyStatuses?.length) {
          const statusValue = plainText(p.properties[props.status]);
          if (!statusValue || !opts.readyStatuses.includes(statusValue)) continue;
        }
        if (!explicitSelection && opts.projects?.length) {
          if (!props.project) {
            throw new Error(
              "notionTicketSource: `projects` filter requires `properties.project` to be set to the " +
                "database's project-name property (e.g. a rollup showing the related project's title).",
            );
          }
          const projectValue = plainText(p.properties[props.project]);
          if (!projectValue || !opts.projects.includes(projectValue)) continue;
        }
        const repoId = props.repo
          ? (plainText(p.properties[props.repo]) ?? opts.defaultRepoId)
          : opts.defaultRepoId;

        const propertyBody = props.body ? plainText(p.properties[props.body]) : undefined;
        let pageContent: string | undefined;
        if (opts.includePageContent ?? true) {
          pageContent = await fetchPageContent(baseUrl, apiKey, p.id);
        }
        const body = [propertyBody, pageContent].filter(Boolean).join("\n\n") || undefined;

        tickets.push({
          source: "notion",
          externalId: p.id,
          externalUrl: p.url,
          title,
          body,
          repoId,
          repoPath: repoId === opts.defaultRepoId ? opts.defaultRepoPath : repoId,
        });
      }
      return tickets;
    },
  };
}

const MAX_BLOCK_DEPTH = 3; // caps recursion into deeply nested toggles/lists
const MAX_BLOCKS_PAGE_SIZE = 100;

/**
 * Fetches a Notion page's body content (the blocks rendered below the
 * title/properties) and flattens it to plain text, recursing into
 * children (nested lists, toggles, etc.) up to MAX_BLOCK_DEPTH. This is
 * distinct from `properties.body` — that's one specific database
 * property; this is literally what you see scrolling down the page.
 */
async function fetchPageContent(
  baseUrl: string,
  apiKey: string,
  blockId: string,
  depth = 0,
): Promise<string | undefined> {
  if (depth >= MAX_BLOCK_DEPTH) return undefined;
  const lines: string[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${baseUrl}/v1/blocks/${blockId}/children`);
    url.searchParams.set("page_size", String(MAX_BLOCKS_PAGE_SIZE));
    if (cursor) url.searchParams.set("start_cursor", cursor);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": NOTION_VERSION,
      },
    });
    if (!res.ok) {
      // Non-fatal: a page the integration can read via query but not via
      // blocks (rare permission edge case) shouldn't kill the whole run.
      return lines.length ? lines.join("\n") : undefined;
    }
    const data = (await res.json()) as {
      results: NotionBlock[];
      has_more: boolean;
      next_cursor: string | null;
    };
    for (const block of data.results) {
      const text = blockPlainText(block);
      if (text) lines.push(text);
      if (block.has_children) {
        const nested = await fetchPageContent(baseUrl, apiKey, block.id, depth + 1);
        if (nested) lines.push(nested);
      }
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  } while (true);
  return lines.length ? lines.join("\n") : undefined;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

/** Flattens the handful of common Notion block types into a plain-text line. */
function blockPlainText(block: NotionBlock): string | undefined {
  const rich = (block as Record<string, { rich_text?: { plain_text: string }[] }>)[block.type];
  const text = rich?.rich_text?.map((t) => t.plain_text).join("") ?? "";
  if (!text) return undefined;
  switch (block.type) {
    case "heading_1":
    case "heading_2":
    case "heading_3":
      return `${text}`;
    case "bulleted_list_item":
    case "to_do":
      return `- ${text}`;
    case "numbered_list_item":
      return `- ${text}`;
    case "quote":
    case "callout":
      return `> ${text}`;
    default:
      return text;
  }
}

async function fetchCurrentUserId(baseUrl: string, apiKey: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/users/me`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  if (!res.ok) {
    throw new Error(`Notion /users/me failed: ${res.status} ${await res.text()}`);
  }
  const me = (await res.json()) as {
    id: string;
    type?: "person" | "bot";
    bot?: { owner?: { type?: "workspace" | "user"; user?: { id: string } } };
  };
  // `/v1/users/me` returns the integration's *bot* user, not you. For a
  // personal internal integration (owner.type === "user"), Notion tells us
  // which human owns it -- use that id so the assignee filter matches
  // "People" properties, which reference real workspace members, not bots.
  // For a workspace-owned/shared integration there's no way to infer which
  // teammate is running it; callers must pass `assigneeUserId` explicitly
  // in that case (see README).
  if (me.type === "bot" && me.bot?.owner?.type === "user" && me.bot.owner.user?.id) {
    return me.bot.owner.user.id;
  }
  return me.id;
}

function buildFilter(args: {
  assigneeProp?: string;
  assigneeUserId?: string;
}): NotionFilter | undefined {
  const clauses: NotionFilter[] = [];
  if (args.assigneeProp && args.assigneeUserId) {
    clauses.push({
      property: args.assigneeProp,
      people: { contains: args.assigneeUserId },
    });
  }
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { and: clauses };
}

type NotionFilter =
  | { and: NotionFilter[] }
  | { or: NotionFilter[] }
  | { property: string; people: { contains: string } };

interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, NotionProperty>;
  archived?: boolean;
  in_trash?: boolean;
}

type NotionProperty = {
  type: string;
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  select?: { name: string } | null;
  status?: { name: string } | null;
  url?: string;
  multi_select?: { name: string }[];
  rollup?: {
    type: string;
    array?: NotionProperty[];
  };
};

/**
 * Reads a property's plain-text value. Notion has two distinct "labeled
 * dropdown" property types with the same underlying shape — the older
 * `select` and the newer `status` (which newly-created databases/boards
 * often use by default) — so both are handled the same way here. Also
 * handles `multi_select` (comma-joined) and `rollup` (recurses into the
 * rolled-up values, e.g. a rollup surfacing a related project's title —
 * the common way to get a readable name out of a `relation` property,
 * which by itself only exposes opaque ids).
 */
function plainText(prop: NotionProperty | undefined): string | undefined {
  if (!prop) return undefined;
  if (prop.type === "title") return prop.title?.map((t) => t.plain_text).join("") || undefined;
  if (prop.type === "rich_text")
    return prop.rich_text?.map((t) => t.plain_text).join("") || undefined;
  if (prop.type === "url") return prop.url ?? undefined;
  if (prop.type === "select") return prop.select?.name;
  if (prop.type === "status") return prop.status?.name;
  if (prop.type === "multi_select") return prop.multi_select?.map((s) => s.name).join(", ") || undefined;
  if (prop.type === "rollup" && prop.rollup?.type === "array") {
    return prop.rollup.array?.map((item) => plainText(item)).filter(Boolean).join(", ") || undefined;
  }
  return undefined;
}
