# Alfred

Alfred is a small incident assistant for on-call engineers, built entirely on Cloudflare. You report an incident (title, activated alarms or indicators, your notes), Alfred works through it with you in chat, and when you mark it resolved a Workflow writes the postmortem and files the incident, notes and full transcript in long-term memory. Later incidents are answered with the most similar past ones as context.

The UI uses [Fluent UI Web Components](https://github.com/microsoft/fluentui/tree/master/packages/web-components) v3, bundled with esbuild into the Worker's static assets.

Developed by me and Claude, prompt history [here](./PROMPTS.md)

## Flow

1. **Intake**: title, alarms / indicators, notes. Submitting creates a live incident (one Durable Object per incident) and Alfred immediately answers the intake.
2. **Chat**: reply by text or voice. On every turn the library is searched for similar past incidents (shared alarm names, services, error strings) and the top three are added to the prompt.
3. **Resolve**: *Mark resolved* starts a Workflow: freeze the incident → draft the postmortem (summary, root cause, action items) → file it in the library → mark resolved. Each step is checkpointed and retried independently.
4. **Library**: browse resolved incidents with their postmortems. They feed step 2 for future incidents.


## Run it

Prerequisites: Node 20+ and a Cloudflare account (Workers AI runs remotely, even under `wrangler dev`).

```bash
npm install
npx wrangler login
npm run dev  
npm run deploy   
```

## Try it

1. Title "Checkout latency spike"; alarms "p99 checkout latency > 2s, 5xx rate 4%"; notes "deploy of payments-api went out 10 minutes ago".
2. Work through a few turns, then click **Mark resolved** (e.g. after saying it was rolled back).
3. Open **Library** to see the postmortem.
4. Start a second incident mentioning payments-api and a deploy: Alfred should reference the first one.

## API

- `POST /api/incidents` with `{ title, alarms, notes }` returns `{ id }`
- `GET /api/incidents/:id` returns intake, status and transcript
- `POST /api/incidents/:id/chat` with `{ message? }` returns an SSE stream (no message answers the intake)
- `POST /api/incidents/:id/resolve` starts the Workflow, returns `{ workflowId }`
- `GET /api/workflows/:id` returns the Workflow status
- `GET /api/library` and `GET /api/library/:id` return resolved incidents

## Authentication (Cloudflare Access)

The Worker expects to sit behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/). `/api/*` requests are rejected with 401 unless they carry a valid `Cf-Access-Jwt-Assertion` (signature, issuer, audience and expiry are checked in `src/access.ts`). If `TEAM_DOMAIN` / `POLICY_AUD` are unset, the API fails closed.

1. Zero Trust dashboard → **Access → Applications → Add → Self-hosted**. Use the Worker's hostname (custom domain, or enable Access on the `workers.dev` / preview URLs under Workers → Settings → Domains & Routes).
2. Add an identity provider and a policy (e.g. emails ending in `@yourco.com`).
3. Copy the application's **Audience (AUD) tag** and your team domain (`<team>.cloudflareaccess.com`) into `vars` in `wrangler.jsonc`, then `npm run deploy`.
4. Local dev: `.dev.vars` contains `ACCESS_DISABLED=true` (git-ignored), which skips validation under `wrangler dev`.

### Reporter and secondaries

Each incident is tagged with the reporter's email from the Access JWT. List team emails (comma-separated) in `TEAM_MEMBERS` in `wrangler.jsonc` (or `.dev.vars` locally) and the intake form offers them as checkboxes; the ones ticked are stored as the incident's secondaries. The server only accepts roster members, never the reporter. Both fields show in the incident header and the library. Locally the reporter is `dev@localhost`.
