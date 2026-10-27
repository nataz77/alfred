import { authenticate } from "./access";
import { LIBRARY_NAME, type Env, type IncidentIntake } from "./types";

export { ChatSession } from "./session";
export { IncidentLibrary } from "./library";
export { ResolveWorkflow } from "./workflow";

const json = (body: unknown, status = 200) => Response.json(body, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "incidents", id, action]
    if (parts[0] !== "api") return env.ASSETS.fetch(request);

    const user = await authenticate(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);

    const library = env.LIBRARY.get(env.LIBRARY.idFromName(LIBRARY_NAME));
    const session = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));
    const method = request.method;

    const roster = (env.TEAM_MEMBERS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

    // GET /api/me -> the signed-in user (from Access) and the team that can be added as secondaries
    if (parts[1] === "me" && method === "GET") {
      return json({ email: user.email, team: roster.filter((e) => e !== user.email.toLowerCase()) });
    }

    // POST /api/incidents  -> intake form: creates the incident, tagged with the reporter
    if (parts[1] === "incidents" && parts.length === 2 && method === "POST") {
      const intake = (await request.json()) as Partial<IncidentIntake> & { secondaries?: string[] };
      if (!intake.title?.trim()) return json({ error: "title required" }, 400);
      // Only roster members (never the reporter) can be secondaries; ignore anything else.
      const secondaries = [
        ...new Set((intake.secondaries ?? []).map((e) => String(e).trim().toLowerCase())),
      ].filter((e) => roster.includes(e) && e !== user.email.toLowerCase());
      const id = crypto.randomUUID();
      await session(id).start(
        {
          title: intake.title.trim(),
          alarms: intake.alarms?.trim() ?? "",
          notes: intake.notes?.trim() ?? "",
        },
        user.email,
        secondaries,
      );
      return json({ id }, 201);
    }

    // GET /api/incidents/:id  -> live incident (intake, status, transcript)
    if (parts[1] === "incidents" && parts.length === 3 && method === "GET") {
      const s = session(parts[2]);
      const meta = await s.getMeta();
      if (!meta) return json({ error: "not found" }, 404);
      return json({ id: parts[2], ...meta, messages: await s.getHistory() });
    }

    // POST /api/incidents/:id/chat  { message? } -> streamed reply
    if (parts[1] === "incidents" && parts[3] === "chat" && method === "POST") {
      const { message } = (await request.json().catch(() => ({}))) as { message?: string };
      return session(parts[2]).chat(message);
    }

    // POST /api/incidents/:id/resolve -> starts the Workflow
    if (parts[1] === "incidents" && parts[3] === "resolve" && method === "POST") {
      const meta = await session(parts[2]).getMeta();
      if (!meta) return json({ error: "not found" }, 404);
      if (meta.status !== "open") return json({ error: `incident is ${meta.status}` }, 409);
      const instance = await env.RESOLVE.create({ params: { incidentId: parts[2] } });
      return json({ workflowId: instance.id }, 202);
    }

    // GET /api/workflows/:id -> Workflow status (+ postmortem output when complete)
    if (parts[1] === "workflows" && parts.length === 3 && method === "GET") {
      const instance = await env.RESOLVE.get(parts[2]);
      return json(await instance.status());
    }

    // GET /api/library, GET /api/library/:id -> resolved incidents
    if (parts[1] === "library" && method === "GET") {
      if (parts.length === 2) return json(await library.list());
      const found = await library.get(parts[2]);
      return found ? json(found) : json({ error: "not found" }, 404);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
