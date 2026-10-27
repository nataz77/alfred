import "@fluentui/web-components/button.js";
import "@fluentui/web-components/text-input.js";
import "@fluentui/web-components/textarea.js";
import "@fluentui/web-components/label.js";
import "@fluentui/web-components/badge.js";
import "@fluentui/web-components/tablist.js";
import "@fluentui/web-components/tab.js";
import "@fluentui/web-components/accordion.js";
import "@fluentui/web-components/accordion-item.js";
import "@fluentui/web-components/message-bar.js";
import "@fluentui/web-components/spinner.js";
import "@fluentui/web-components/divider.js";
import { setTheme } from "@fluentui/web-components/theme/set-theme.js";
import { webDarkTheme, webLightTheme } from "@fluentui/tokens";

type Field = HTMLElement & { value: string };
type Msg = { role: "user" | "assistant"; content: string };
type Status = "open" | "resolving" | "resolved";
type Incident = {
  id: string; title: string; alarms: string; notes: string; status: Status; messages: Msg[];
  reporter: string; secondaries: string[];
};
type Postmortem = { summary: string; rootCause: string; actionItems: string[] };
type LibraryRow = { id: string; title: string; summary: string; resolvedAt: string };
type LibraryEntry = LibraryRow & Postmortem & {
  alarms: string; notes: string; transcript: Msg[]; reporter: string; secondaries: string[];
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | string,
  attrs: Record<string, string> = {},
  ...children: (string | Node)[]
): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => setTheme(dark.matches ? webDarkTheme : webLightTheme);
applyTheme();
dark.addEventListener("change", applyTheme);

const store = {
  get: () => { try { return localStorage.getItem("incident"); } catch { return null; } },
  set: (v: string | null) => { try { v ? localStorage.setItem("incident", v) : localStorage.removeItem("incident"); } catch { /* storage unavailable */ } },
};

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json() as Promise<T>;
};
const post = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

let incident: Incident | null = null;
let busy = false;

function banner(text: string, intent: "error" | "info" = "error") {
  const bar = $("banner");
  bar.replaceChildren();
  if (!text) return;
  const m = h("fluent-message-bar", { intent }, text);
  bar.append(m);
}

// ---------- views ----------
const views = ["intake", "chat", "library"] as const;
function show(view: (typeof views)[number]) {
  for (const v of views) $(`view-${v}`).hidden = v !== view;
}

function renderMessage(m: Msg) {
  const el = h("div", { class: `msg ${m.role}` });
  el.textContent = m.content;
  $("log").append(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}

function postmortemCard(p: Postmortem) {
  return h(
    "div",
    { class: "card" },
    h("strong", {}, "Postmortem"),
    h("p", {}, p.summary),
    h("p", {}, h("strong", {}, "Root cause: "), p.rootCause),
    h("strong", {}, "Action items"),
    h("ul", {}, ...p.actionItems.map((a) => h("li", {}, a))),
  );
}

function renderIncident() {
  if (!incident) return show("intake");
  show("chat");
  $("title").textContent = incident.title;
  const badge = $("status");
  badge.textContent = incident.status;
  badge.setAttribute("color", incident.status === "open" ? "danger" : incident.status === "resolving" ? "warning" : "success");
  ($("resolve") as HTMLButtonElement).disabled = incident.status !== "open";
  $("composer").hidden = incident.status !== "open";
  $("log").replaceChildren();
  // The first user turn is the intake form echoed as a prompt; show the form fields instead.
  $("log").append(
    h("dl", { class: "intake" },
      ...(incident.reporter ? [h("dt", {}, "Reporter"), h("dd", {}, incident.reporter)] : []),
      ...(incident.secondaries.length ? [h("dt", {}, "Secondaries"), h("dd", {}, incident.secondaries.join(", "))] : []),
      h("dt", {}, "Alarms"), h("dd", {}, incident.alarms || "(none)"),
      h("dt", {}, "Notes"), h("dd", {}, incident.notes || "(none)")),
  );
  incident.messages.slice(1).forEach(renderMessage);
}

// ---------- chat ----------
async function streamReply(message?: string) {
  if (!incident || busy) return;
  busy = true;
  const out = renderMessage({ role: "assistant", content: "" });
  const spinner = h("fluent-spinner", { size: "tiny" });
  out.append(spinner);
  try {
    const res = await fetch(`/api/incidents/${incident.id}/chat`, {
      method: "POST",
      body: JSON.stringify(message ? { message } : {}),
    });
    if (!res.ok || !res.body) throw new Error((await res.text()) || res.statusText);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.startsWith("data: ") || l.includes("[DONE]")) continue;
        try { text += (JSON.parse(l.slice(6)) as { response?: string }).response ?? ""; } catch { /* partial frame */ }
      }
      out.textContent = text;
      $("log").scrollTop = $("log").scrollHeight;
    }
    // The reply is persisted server side after the stream ends; reflect it locally.
    incident.messages.push({ role: "assistant", content: text });
  } catch (e) {
    out.remove();
    banner(`Chat failed: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}

async function loadIncident(id: string) {
  try {
    incident = await api<Incident>(`/api/incidents/${id}`);
    store.set(id);
  } catch {
    incident = null;
    store.set(null);
  }
  renderIncident();
  if (incident?.status === "resolved") {
    const p = await api<Postmortem>(`/api/library/${incident.id}`).catch(() => null);
    if (p) $("log").append(postmortemCard(p));
  }
  $("log").scrollTop = $("log").scrollHeight;
  // An incident created but never answered (page closed mid-start) picks up where it left off.
  if (incident?.status === "open" && incident.messages.at(-1)?.role === "user") void streamReply();
}

// ---------- intake ----------
$("start").addEventListener("click", async () => {
  const title = ($("f-title") as Field).value.trim();
  if (!title) return banner("Give the incident a title.");
  banner("");
  try {
    const { id } = await post<{ id: string }>("/api/incidents", {
      title,
      alarms: ($("f-alarms") as Field).value,
      notes: ($("f-notes") as Field).value,
      secondaries: [...document.querySelectorAll<HTMLInputElement>("#secondaries input:checked")].map((c) => c.value),
    });
    for (const f of ["f-title", "f-alarms", "f-notes"]) ($(f) as Field).value = "";
    document.querySelectorAll<HTMLInputElement>("#secondaries input").forEach((c) => (c.checked = false));
    await loadIncident(id);
  } catch (e) {
    banner(`Could not start the incident: ${(e as Error).message}`);
  }
});

// ---------- composer ----------
const input = $("input") as Field;
async function send() {
  const message = input.value.trim();
  if (!message || !incident || incident.status !== "open") return;
  input.value = "";
  banner("");
  incident.messages.push({ role: "user", content: message });
  renderMessage({ role: "user", content: message });
  await streamReply(message);
}
$("send").addEventListener("click", send);
input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void send(); });

// Voice input via the browser Web Speech API.
const mic = $("mic");
const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
if (!SR) mic.hidden = true;
else {
  const rec = new SR();
  rec.interimResults = false;
  rec.onresult = (ev: any) => { input.value = ev.results[0][0].transcript; };
  rec.onend = () => mic.setAttribute("appearance", "subtle");
  mic.addEventListener("click", () => { mic.setAttribute("appearance", "primary"); rec.start(); });
}

// ---------- resolve (Workflow) ----------
$("resolve").addEventListener("click", async () => {
  if (!incident || busy) return;
  banner("");
  const id = incident.id;
  $("composer").hidden = true;
  ($("resolve") as HTMLButtonElement).disabled = true;
  banner("Postmortem workflow running…", "info");
  try {
    const { workflowId } = await post<{ workflowId: string }>(`/api/incidents/${id}/resolve`);
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await api<{ status: string; error?: { message?: string } }>(`/api/workflows/${workflowId}`);
      if (s.status === "complete") break;
      if (s.status === "errored" || s.status === "terminated")
        throw new Error(s.error?.message ?? s.status);
    }
    banner("");
    await loadIncident(id);
  } catch (e) {
    banner(`Workflow failed: ${(e as Error).message}`);
    await loadIncident(id); // status may still be open (retry) or stuck in resolving
  }
});

$("new").addEventListener("click", () => {
  incident = null;
  store.set(null);
  banner("");
  renderIncident();
});

// ---------- library ----------
async function renderLibrary() {
  const root = $("library-list");
  root.replaceChildren(h("fluent-spinner", {}));
  const rows = await api<LibraryRow[]>("/api/library");
  root.replaceChildren();
  if (!rows.length) {
    root.append(h("p", { class: "muted" }, "No resolved incidents yet. Resolve one and it appears here, and feeds later chats."));
    return;
  }
  const acc = h("fluent-accordion");
  for (const r of rows) {
    const item = h("fluent-accordion-item");
    item.append(h("span", { slot: "heading" }, `${r.title} · ${r.resolvedAt.slice(0, 10)}`));
    const body = h("div", { class: "entry" }, h("fluent-spinner", { size: "tiny" }));
    item.append(body);
    item.addEventListener("click", async () => {
      if (body.dataset.loaded) return;
      body.dataset.loaded = "1";
      const e = await api<LibraryEntry>(`/api/library/${r.id}`);
      body.replaceChildren(
        ...(e.reporter ? [h("p", {}, h("strong", {}, "Reporter: "), e.reporter)] : []),
        ...(e.secondaries.length ? [h("p", {}, h("strong", {}, "Secondaries: "), e.secondaries.join(", "))] : []),
        h("p", {}, h("strong", {}, "Alarms: "), e.alarms || "(none)"),
        postmortemCard(e),
        h("p", { class: "muted" }, `${e.transcript.length} messages stored`),
      );
    });
    acc.append(item);
  }
  root.append(acc);
}

const nav = $("nav");
nav.addEventListener("change", () => {
  const active = nav.getAttribute("activeid");
  if (active === "t-library") {
    show("library");
    void renderLibrary();
  } else {
    renderIncident();
  }
});

// ---------- team (secondaries picker) ----------
async function loadTeam() {
  try {
    const { team } = await api<{ email: string; team: string[] }>("/api/me");
    $("secondaries").replaceChildren(
      ...team.map((email) => {
        const box = h("input", { type: "checkbox", value: email });
        return h("label", {}, box, email);
      }),
    );
    $("secondaries-field").hidden = !team.length;
  } catch { /* no roster: the intake form just omits the picker */ }
}

// ---------- boot ----------
void loadTeam();
const saved = store.get();
if (saved) void loadIncident(saved);
else renderIncident();
