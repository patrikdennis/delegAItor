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
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
