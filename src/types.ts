import type { ChatSession } from "./session";
import type { IncidentLibrary } from "./library";

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  SESSION: DurableObjectNamespace<ChatSession>;
  LIBRARY: DurableObjectNamespace<IncidentLibrary>;
  RESOLVE: Workflow<ResolveParams>;
  /** Cloudflare Access team domain, e.g. "myteam.cloudflareaccess.com". */
  TEAM_DOMAIN?: string;
  /** Audience (AUD) tag of the Access application protecting this Worker. */
  POLICY_AUD?: string;
  /** "true" skips Access validation; local dev only. */
  ACCESS_DISABLED?: string;
  /** Comma-separated emails that can be added as secondaries when an incident is created. */
  TEAM_MEMBERS?: string;
}

export interface ResolveParams {
  incidentId: string;
}

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

/** What the engineer enters on the intake form. */
export interface IncidentIntake {
  title: string;
  alarms: string;
  notes: string;
}

export type IncidentStatus = "open" | "resolving" | "resolved";

export interface Postmortem {
  summary: string;
  rootCause: string;
  actionItems: string[];
}

/** A resolved incident as kept in the library: intake, postmortem and full transcript. */
export interface ResolvedIncident extends IncidentIntake, Postmortem {
  id: string;
  /** Email (from Cloudflare Access) of the engineer who opened the incident. */
  reporter: string;
  /** Team members added as secondaries when the incident was created. */
  secondaries: string[];
  resolvedAt: string;
  transcript: ChatMessage[];
}

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const LIBRARY_NAME = "library";
