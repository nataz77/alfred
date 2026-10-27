import { DurableObject } from "cloudflare:workers";
import type { ChatMessage, Env, ResolvedIncident } from "./types";

type Row = {
  id: string;
  title: string;
  alarms: string;
  notes: string;
  summary: string;
  root_cause: string;
  action_items: string;
  transcript: string;
  resolved_at: string;
  reporter: string;
  secondaries: string;
};

const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? []);

const fromRow = (r: Row): ResolvedIncident => ({
  id: r.id,
  title: r.title,
  alarms: r.alarms,
  notes: r.notes,
  reporter: r.reporter,
  secondaries: JSON.parse(r.secondaries) as string[],
  summary: r.summary,
  rootCause: r.root_cause,
  actionItems: JSON.parse(r.action_items) as string[],
  transcript: JSON.parse(r.transcript) as ChatMessage[],
  resolvedAt: r.resolved_at,
});

// Singleton Durable Object: long-term memory shared by every incident session.
export class IncidentLibrary extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        alarms TEXT NOT NULL,
        notes TEXT NOT NULL,
        summary TEXT NOT NULL,
        root_cause TEXT NOT NULL,
        action_items TEXT NOT NULL,
        transcript TEXT NOT NULL,
        resolved_at TEXT NOT NULL
      )
    `);
    // Library entries filed before reporters/secondaries existed keep working with empty values.
    const cols = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(incidents)").toArray().map((c) => c.name);
    if (!cols.includes("reporter")) ctx.storage.sql.exec("ALTER TABLE incidents ADD COLUMN reporter TEXT NOT NULL DEFAULT ''");
    if (!cols.includes("secondaries")) ctx.storage.sql.exec("ALTER TABLE incidents ADD COLUMN secondaries TEXT NOT NULL DEFAULT '[]'");
  }

  save(i: ResolvedIncident): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO incidents
         (id, title, alarms, notes, summary, root_cause, action_items, transcript, resolved_at, reporter, secondaries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      i.id,
      i.title,
      i.alarms,
      i.notes,
      i.summary,
      i.rootCause,
      JSON.stringify(i.actionItems),
      JSON.stringify(i.transcript),
      i.resolvedAt,
      i.reporter,
      JSON.stringify(i.secondaries),
    );
  }

  list(): Pick<ResolvedIncident, "id" | "title" | "summary" | "resolvedAt">[] {
    return this.ctx.storage.sql
      .exec<Pick<Row, "id" | "title" | "summary" | "resolved_at">>(
        "SELECT id, title, summary, resolved_at FROM incidents ORDER BY resolved_at DESC",
      )
      .toArray()
      .map((r) => ({ id: r.id, title: r.title, summary: r.summary, resolvedAt: r.resolved_at }));
  }

  get(id: string): ResolvedIncident | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT * FROM incidents WHERE id = ?", id).toArray()[0];
    return row ? fromRow(row) : null;
  }

  /** Past incidents that share the most vocabulary (alarm names, services, error strings) with the query. */
  similar(query: string, limit = 3, excludeId?: string): ResolvedIncident[] {
    const wanted = tokens(query);
    const rows = this.ctx.storage.sql.exec<Row>("SELECT * FROM incidents").toArray();
    return rows
      .filter((r) => r.id !== excludeId)
      .map((r) => {
        const have = tokens(`${r.title} ${r.alarms} ${r.notes} ${r.summary} ${r.root_cause}`);
        let score = 0;
        for (const t of wanted) if (have.has(t)) score++;
        return { r, score };
      })
      .filter((x) => x.score >= 2) // one shared word (an "api" or "p99") is noise, not a similar incident
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => fromRow(x.r));
  }
}
