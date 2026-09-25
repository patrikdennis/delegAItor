import { getDb } from "../db.js";

export type MessageKind = "note" | "conflict" | "question" | "answer" | "blocked" | "done";

export interface SendMessageInput {
  fromSessionId: string;
  /** Deliver to every session working the same ticket. */
  toTicketId?: string;
  /** Deliver to one specific session. */
  toSessionId?: string;
  body: string;
  kind?: MessageKind;
}

export interface StoredMessage {
  id: number;
  fromSessionId: string;
  toTicketId: string | null;
  toSessionId: string | null;
  body: string;
  kind: MessageKind;
  createdAt: string;
  readAt: string | null;
}

/**
 * Sends a message either to a specific session or broadcast to every
 * session currently assigned to the same ticket. This is how two agents
 * editing the same ticket/resource concurrently coordinate: e.g. session A
 * posts a "conflict" message before touching a shared file, session B
 * polls for messages targeted at its ticket and responds.
 */
export function sendMessage(input: SendMessageInput): number {
  const info = getDb()
    .prepare(
      `INSERT INTO messages (from_session_id, to_ticket_id, to_session_id, body, kind)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.fromSessionId,
      input.toTicketId ?? null,
      input.toSessionId ?? null,
      input.body,
      input.kind ?? "note",
    );
  return Number(info.lastInsertRowid);
}

export function unreadMessagesFor(opts: { ticketId?: string; sessionId?: string }): StoredMessage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, from_session_id as fromSessionId, to_ticket_id as toTicketId,
              to_session_id as toSessionId, body, kind, created_at as createdAt, read_at as readAt
       FROM messages
       WHERE read_at IS NULL
         AND ((to_ticket_id = ? AND ? IS NOT NULL) OR (to_session_id = ? AND ? IS NOT NULL))
       ORDER BY created_at ASC`,
    )
    .all(opts.ticketId ?? null, opts.ticketId ?? null, opts.sessionId ?? null, opts.sessionId ?? null);
  return rows as StoredMessage[];
}

export function markRead(messageId: number): void {
  getDb().prepare(`UPDATE messages SET read_at = datetime('now') WHERE id = ?`).run(messageId);
}
