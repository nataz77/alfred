# Prompt history

This app was built with Claude Code (Claude Sonnet 5.5) in a single session on 2026-10-24. This file lists the prompts I gave it, in order. My prompts are verbatim. The "Outcome" notes are short summaries of what the AI did in response.

## 1. Initial brief

> I'd like to design an AI powered on-call incident-triage copilot based on Cloudflare product. It should include the following components:
> - LLM
> - Workflow / coordination
> - User input via chat or voice
> - Memory or state
> Map them to the respective Cloudflare product
> ### General design and flow
> - Intake: the user details an incident, activated alarms or indicators and any notes they have.
> - Chat: that activates the chat, helping the user work though the incident.
> - Solve: Once the incident is solved store it in a database (ie: sqlite) and the postmortem notes along with the transcript for future use to be fed with later prompts
> ### Stack
> I'd like to develop this with Typescript
> ### UI/UX
> Develop the UI using Microsoft Fluent UI webcomponents, keep the stack always based on cloudflare tools
>
> ### Other notes
> - No authentication for the moment, we'll add support in a later stage.


**Outcome:** The AI started developing the product and mapped each requirement to a Cloudflare product:

- Llama 3.3 70B on Workers AI, streamed to the browser
- A Workflow that summarizes the transcript and extracts action items
- A chat UI with browser voice input
- A SQLite-backed Durable Object per session

The AI also added a shared incident library:

- `ChatSession` is a SQLite Durable Object per incident.
- A Workflow freezes the incident on resolve, drafts the postmortem and files it in the library.
- Each chat turn retrieves the three most similar past incidents and feeds them into the prompt.
- The UI uses Fluent UI web components.


## 2. UI polish

> Let's polish the UI a bit, the Chat ui looks a bit wonky

**Outcome:** The AI drove the real UI in a browser and fixed several issues:

- Form field widths, which Fluent caps by default.
- The first chat bubble was a raw dump of the intake form. It is now a small Alarms / Notes card.
- Reload flashed the intake form before restoring the open incident.
- Library line breaks collapsed, and the scrollbar stayed light in dark mode.
- The model cited an invented past incident. It now only gets past-incident instructions when real matches are attached, and a minimum similarity threshold applies.

## 3. Authentication
> I'd like to add Cloudflare Access support, along with integrating it in the incident workflow by adding
> - The reporter of the incident, which will then be refered as primary, with the ability to change it in further steps
> - A list of team members that, upon incident creation, might be added as "secondaries" on the incident.

**Outcome:** The AI laid out the Access integration. Typecheck and build pass; 

- `src/access.ts` verifies the `Cf-Access-Jwt-Assertion` token (RS256 signature against the team's JWKS, issuer, audience, expiry). Every `/api/*` request needs a valid token, and the API fails closed if `TEAM_DOMAIN` / `POLICY_AUD` are not set. A git-ignored `.dev.vars` with `ACCESS_DISABLED=true` keeps local dev working.
- The reporter's email is stored on the incident and shown in the chat header and the library.
- A `TEAM_MEMBERS` list in `wrangler.jsonc` feeds a checkbox picker on the intake form. Ticked members are saved as secondaries, and the server only accepts roster members, never the reporter.
- Existing Durable Objects get the new columns added on first load, so older incidents and library entries still work.
- Typechecked but not deployed/built


## Notes

- Workers AI calls run remotely even under `wrangler dev`, so local runs need `npx wrangler login`.
