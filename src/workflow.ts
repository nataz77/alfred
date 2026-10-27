import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { LIBRARY_NAME, MODEL, type Env, type Postmortem, type ResolveParams } from "./types";

const retry = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;

const POSTMORTEM_PROMPT = `You write blameless postmortems from an incident chat transcript.
Return only a JSON object with these keys:
"summary": under 120 words covering impact, detection, what was tried and how it was resolved,
"rootCause": one or two sentences, or "Not established" if the transcript does not say,
"actionItems": an array of at most 5 short follow-up strings.
Use only facts that appear in the transcript.`;

// Resolve flow: freeze the incident -> draft the postmortem -> file it in the library -> mark resolved.
// Every step is checkpointed and retried on its own, so a flaky model call never loses earlier work.
export class ResolveWorkflow extends WorkflowEntrypoint<Env, ResolveParams> {
  async run(event: WorkflowEvent<ResolveParams>, step: WorkflowStep) {
    const { incidentId } = event.payload;
    const session = this.env.SESSION.get(this.env.SESSION.idFromName(incidentId));
    const library = this.env.LIBRARY.get(this.env.LIBRARY.idFromName(LIBRARY_NAME));

    const transcript = await step.do("freeze incident", async () => {
      await session.setStatus("resolving");
      const text = (await session.getHistory())
        .map((m) => `${m.role === "user" ? "ENGINEER" : "ALFRED"}: ${m.content}`)
        .join("\n\n");
      if (!text) throw new Error("nothing to summarize: the incident has no messages");
      return text;
    });

    const postmortem = await step.do("draft postmortem", retry, async (): Promise<Postmortem> => {
      const out = (await this.env.AI.run(MODEL, {
        messages: [
          { role: "system", content: POSTMORTEM_PROMPT },
          { role: "user", content: transcript },
        ],
        max_tokens: 700,
      })) as { response?: string };
      const json = out.response?.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error("model did not return JSON"); // triggers a retry
      const p = JSON.parse(json) as Partial<Postmortem>;
      return {
        summary: String(p.summary ?? ""),
        rootCause: String(p.rootCause ?? "Not established"),
        actionItems: Array.isArray(p.actionItems) ? p.actionItems.map(String).slice(0, 5) : [],
      };
    });

    await step.do("file in library", async () => {
      await library.save(await session.snapshot(incidentId, postmortem));
      await session.setStatus("resolved");
    });

    return postmortem;
  }
}
