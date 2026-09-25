import { getDb } from "../db.js";

export interface LockRequest {
  repoId: string;
  resource: string;
  ticketId: string;
  sessionId: string;
}

export interface ActiveLock {
  id: number;
  resource: string;
  ticketId: string;
  sessionId: string;
  acquiredAt: string;
}

/**
 * Advisory lock on a logical resource (a file path, a service name, a
 * migration id — anything two tickets might both need to change). Locks
 * are advisory: agents are instructed to check before editing shared
 * resources, and delegAItor surfaces conflicts, but nothing prevents raw
 * git edits outside the protocol.
 */
export function acquireLock(req: LockRequest): { ok: true; lockId: number } | { ok: false; heldBy: ActiveLock } {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id, resource, ticket_id as ticketId, session_id as sessionId, acquired_at as acquiredAt
       FROM resource_locks
       WHERE repo_id = ? AND resource = ? AND released_at IS NULL`,
    )
    .get(req.repoId, req.resource) as ActiveLock | undefined;

  if (existing && existing.sessionId !== req.sessionId) {
    return { ok: false, heldBy: existing };
  }
  if (existing) {
    return { ok: true, lockId: existing.id };
  }

  const info = db
    .prepare(
      `INSERT INTO resource_locks (resource, repo_id, ticket_id, session_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(req.resource, req.repoId, req.ticketId, req.sessionId);
  return { ok: true, lockId: Number(info.lastInsertRowid) };
}

export function releaseLock(sessionId: string, resource: string): void {
  getDb()
    .prepare(
      `UPDATE resource_locks SET released_at = datetime('now')
       WHERE session_id = ? AND resource = ? AND released_at IS NULL`,
    )
    .run(sessionId, resource);
}

export function releaseAllLocks(sessionId: string): void {
  getDb()
    .prepare(
      `UPDATE resource_locks SET released_at = datetime('now')
       WHERE session_id = ? AND released_at IS NULL`,
    )
    .run(sessionId);
}

export function listActiveLocks(repoId?: string): ActiveLock[] {
  const db = getDb();
  const rows = repoId
    ? db
        .prepare(
          `SELECT id, resource, ticket_id as ticketId, session_id as sessionId, acquired_at as acquiredAt
           FROM resource_locks WHERE repo_id = ? AND released_at IS NULL`,
        )
        .all(repoId)
    : db
        .prepare(
          `SELECT id, resource, ticket_id as ticketId, session_id as sessionId, acquired_at as acquiredAt
           FROM resource_locks WHERE released_at IS NULL`,
        )
        .all();
  return rows as ActiveLock[];
}
