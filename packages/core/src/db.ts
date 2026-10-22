import Database from "better-sqlite3";
import { dbPath } from "./paths.js";

let _db: Database.Database | null = null;

/**
 * Singleton WAL-mode SQLite connection. WAL allows multiple delegAItor
 * processes (CLI invocations, MCP server, background watchers) running
 * concurrently across different terminals/worktrees to read and write
 * shared state safely.
 */
export function getDb(): Database.Database {
  if (_db) return _db;
  const db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  _db = db;
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'planned'
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_url TEXT,
      title TEXT NOT NULL,
      body TEXT,
      repo_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      base_ref TEXT NOT NULL DEFAULT 'main',
      depends_on TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      agent TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      pid INTEGER,
      cmux_workspace_id TEXT,
      status TEXT NOT NULL DEFAULT 'starting',
      result_json TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS resource_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_locks_active
      ON resource_locks(repo_id, resource) WHERE released_at IS NULL;

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_session_id TEXT NOT NULL,
      to_ticket_id TEXT,
      to_session_id TEXT,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_unread
      ON messages(to_ticket_id, read_at);
  `);

  // Columns added after the initial schema; SQLite has no ADD COLUMN IF NOT EXISTS.
  const ticketCols = new Set((db.prepare(`PRAGMA table_info(tickets)`).all() as { name: string }[]).map((c) => c.name));
  if (!ticketCols.has("board_sync_json")) {
    db.exec(`ALTER TABLE tickets ADD COLUMN board_sync_json TEXT`);
  }
  if (!ticketCols.has("branch_naming_json")) {
    db.exec(`ALTER TABLE tickets ADD COLUMN branch_naming_json TEXT`);
  }

  const sessionCols = new Set((db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name));
  if (!sessionCols.has("work_unit_id")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN work_unit_id TEXT`);
  }
  if (!sessionCols.has("multi_repo")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN multi_repo INTEGER NOT NULL DEFAULT 0`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_units (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      repo_alias TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      base_ref TEXT NOT NULL DEFAULT 'main',
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      branch_naming_json TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(ticket_id, repo_alias)
    );

    CREATE INDEX IF NOT EXISTS idx_ticket_units_parent ON ticket_units(ticket_id);
  `);

  const unitCols = new Set((db.prepare(`PRAGMA table_info(ticket_units)`).all() as { name: string }[]).map((c) => c.name));
  if (!unitCols.has("active")) {
    db.exec(`ALTER TABLE ticket_units ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  }

  // Existing single-repo tickets become one "default" work unit without
  // changing their ids, branches, sessions, or lookup behavior.
  db.exec(`
    INSERT OR IGNORE INTO ticket_units
      (id, ticket_id, repo_alias, repo_id, repo_path, base_ref, branch, worktree_path, status, branch_naming_json)
    SELECT t.id, t.id, 'default', t.repo_id, t.repo_path, t.base_ref,
           COALESCE((SELECT s.branch FROM sessions s WHERE s.ticket_id = t.id ORDER BY s.started_at DESC LIMIT 1), t.id),
           COALESCE((SELECT s.worktree_path FROM sessions s WHERE s.ticket_id = t.id ORDER BY s.started_at DESC LIMIT 1), ''),
           t.status, t.branch_naming_json
    FROM tickets t
    WHERE NOT EXISTS (SELECT 1 FROM ticket_units u WHERE u.ticket_id = t.id);

    UPDATE sessions SET work_unit_id = ticket_id
    WHERE work_unit_id IS NULL AND EXISTS (SELECT 1 FROM ticket_units u WHERE u.id = sessions.ticket_id);
  `);
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
