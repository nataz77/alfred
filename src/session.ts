import { DurableObject } from "cloudflare:workers";
import {
  LIBRARY_NAME,
  MODEL,
  type ChatMessage,
  type Env,
  type IncidentIntake,
  type IncidentStatus,
  type ResolvedIncident,
} from "./types";

const SYSTEM_PROMPT = `You are Alfred, an on-call assistant for site reliability engineers working an incident.
The engineer will give you the incident title, the alarms and indicators that triggered the alert, and any notes they have.
Use those as the basis for your responses and investigation. Ask for the missing signal (blast radius,
recent deploys, error rates, dependencies), propose the next 1-3 concrete diagnostic or mitigation steps,
and keep answers short. 
Never invent metrics, log lines or past incidents; if you do not know, say so, ask the engineer for more information, and suggest steps on how to find the information needed. 
If the engineer asks for a root cause, summarize the evidence and propose a likely cause, but do not assert it as fact until the engineer confirms it. `;

const PAST_INCIDENTS_RULE = `Only the past incidents listed below exist.
You may cite any other past incident owned by the same engineer, do not invent any other past incidents and only refer to relevant ones.
Use them as hints, name the one you are drawing from, and remind the engineer to verify that the same cause applies here. `;

type Meta = IncidentIntake & { status: IncidentStatus; createdAt: string; reporter: string; secondaries: string[] };

// One Durable Object per live incident: the intake, the status and the running transcript.
export class ChatSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        title TEXT NOT NULL,
        alarms TEXT NOT NULL,
        notes TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL
      );
    `);
    // Incidents created before reporters/secondaries existed keep working with empty values.
    const cols = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(meta)").toArray().map((c) => c.name);
    if (!cols.includes("reporter")) ctx.storage.sql.exec("ALTER TABLE meta ADD COLUMN reporter TEXT NOT NULL DEFAULT ''");
    if (!cols.includes("secondaries")) ctx.storage.sql.exec("ALTER TABLE meta ADD COLUMN secondaries TEXT NOT NULL DEFAULT '[]'");
  }

  start(intake: IncidentIntake, reporter: string, secondaries: string[]): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (id, title, alarms, notes, status, created_at, reporter, secondaries) VALUES (1, ?, ?, ?, 'open', ?, ?, ?)",
      intake.title,
      intake.alarms,
      intake.notes,
      new Date().toISOString(),
      reporter,
      JSON.stringify(secondaries),
    );
    this.append(
      "user",
      [
        `Incident: ${intake.title}`,
        `Activated alarms / indicators:\n${intake.alarms || "(none given)"}`,
        `My notes:\n${intake.notes || "(none)"}`,
        "Help me work through this.",
      ].join("\n\n"),
    );
  }

  getMeta(): Meta | null {
    const r = this.ctx.storage.sql
      .exec<{
        title: string;
        alarms: string;
        notes: string;
        status: IncidentStatus;
        created_at: string;
        reporter: string;
        secondaries: string;
      }>("SELECT * FROM meta WHERE id = 1")
      .toArray()[0];
    return r
      ? {
          title: r.title,
          alarms: r.alarms,
          notes: r.notes,
          status: r.status,
          createdAt: r.created_at,
          reporter: r.reporter,
          secondaries: JSON.parse(r.secondaries) as string[],
        }
      : null;
  }

  setStatus(status: IncidentStatus): void {
    this.ctx.storage.sql.exec("UPDATE meta SET status = ? WHERE id = 1", status);
  }

  getHistory(): ChatMessage[] {
    return this.ctx.storage.sql
      .exec<ChatMessage>("SELECT role, content FROM messages ORDER BY id")
      .toArray();
  }

  private append(role: ChatMessage["role"], content: string): void {
    this.ctx.storage.sql.exec("INSERT INTO messages (role, content) VALUES (?, ?)", role, content);
  }

  /** Streams the next assistant reply. With no `message` it answers the latest user turn (the intake). */
  async chat(message?: string): Promise<Response> {
    const meta = this.getMeta();
    if (!meta) return new Response("unknown incident", { status: 404 });
    if (meta.status !== "open") return new Response("incident is not open", { status: 409 });
    if (message?.trim()) this.append("user", message.trim());

    const history = this.getHistory();
    if (history.at(-1)?.role !== "user") return new Response("nothing to answer", { status: 400 });

    const library = this.env.LIBRARY.get(this.env.LIBRARY.idFromName(LIBRARY_NAME));
    const lastUser = history.at(-1)!.content;
    const past = await library.similar(
      `${meta.title} ${meta.alarms} ${meta.notes} ${lastUser}`,
      3,
      this.ctx.id.name,
    );
    const system = past.length
      ? `${SYSTEM_PROMPT}\n\n${PAST_INCIDENTS_RULE}\n\nSimilar past incidents:\n${past
          .map(
            (p, n) =>
              `${n + 1}. "${p.title}" (resolved ${p.resolvedAt.slice(0, 10)})\n   Alarms: ${p.alarms}\n   Root cause: ${p.rootCause}\n   Summary: ${p.summary}\n   Follow-ups: ${p.actionItems.join("; ")}`,
          )
          .join("\n")}`
      : SYSTEM_PROMPT;

    const stream = (await this.env.AI.run(MODEL, {
      messages: [{ role: "system", content: system }, ...history.slice(-30)],
      stream: true,
      max_tokens: 700,
    })) as ReadableStream<Uint8Array>;

    // One branch goes to the browser, the other is parsed so the full reply is persisted.
    const [toClient, toStore] = stream.tee();
    this.ctx.waitUntil(this.persistReply(toStore));

    return new Response(toClient, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  private async persistReply(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let reply = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
        try {
          reply += (JSON.parse(line.slice(6)) as { response?: string }).response ?? "";
        } catch {
          // partial or non-JSON frame: skip
        }
      }
    }
    if (reply) this.append("assistant", reply);
  }

  /** Called by the resolve Workflow once the postmortem exists. */
  snapshot(id: string, postmortem: Pick<ResolvedIncident, "summary" | "rootCause" | "actionItems">): ResolvedIncident {
    const meta = this.getMeta()!;
    return {
      id,
      title: meta.title,
      alarms: meta.alarms,
      notes: meta.notes,
      reporter: meta.reporter,
      secondaries: meta.secondaries,
      ...postmortem,
      resolvedAt: new Date().toISOString(),
      transcript: this.getHistory(),
    };
  }
}
