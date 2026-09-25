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
  };
  defaultRepoId: string;
  defaultRepoPath: string;
  /** Notion select value(s) considered "ready to delegate". Defaults to any non-done status. */
  readyStatuses?: string[];
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
        statusProp: !explicitSelection ? props.status : undefined,
        readyStatuses: !explicitSelection ? opts.readyStatuses : undefined,
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
        const title = plainText(p.properties[props.title]);
        if (!title) continue;
        if (explicitSelection && !wanted.some((w) => title.includes(w) || p.id === w)) {
          continue;
        }
        const repoId = props.repo
          ? (plainText(p.properties[props.repo]) ?? opts.defaultRepoId)
          : opts.defaultRepoId;
        tickets.push({
          source: "notion",
          externalId: p.id,
          externalUrl: p.url,
          title,
          body: props.body ? plainText(p.properties[props.body]) : undefined,
          repoId,
          repoPath: repoId === opts.defaultRepoId ? opts.defaultRepoPath : repoId,
        });
      }
      return tickets;
    },
  };
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
  statusProp?: string;
  readyStatuses?: string[];
  assigneeProp?: string;
  assigneeUserId?: string;
}): NotionFilter | undefined {
  const clauses: NotionFilter[] = [];
  if (args.statusProp && args.readyStatuses?.length) {
    clauses.push({
      or: args.readyStatuses.map((status) => ({
        property: args.statusProp!,
        select: { equals: status },
      })),
    });
  }
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
  | { property: string; select: { equals: string } }
  | { property: string; people: { contains: string } };

interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, NotionProperty>;
}

type NotionProperty = {
  type: string;
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  select?: { name: string } | null;
  url?: string;
};

function plainText(prop: NotionProperty | undefined): string | undefined {
  if (!prop) return undefined;
  if (prop.type === "title") return prop.title?.map((t) => t.plain_text).join("") || undefined;
  if (prop.type === "rich_text")
    return prop.rich_text?.map((t) => t.plain_text).join("") || undefined;
  if (prop.type === "url") return prop.url ?? undefined;
  if (prop.type === "select") return prop.select?.name;
  return undefined;
}
