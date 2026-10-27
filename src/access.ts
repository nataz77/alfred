import type { Env } from "./types";

type Jwk = JsonWebKey & { kid: string };

const b64urlToBytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

let jwksCache: { keys: Jwk[]; fetchedAt: number } | undefined;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getKeys(teamDomain: string, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

/**
 * Verifies the Cloudflare Access JWT on a request and returns the caller's email.
 * Returns null when the token is missing or invalid. Fails closed when Access is not configured,
 * unless ACCESS_DISABLED is "true" (local dev only, set in .dev.vars).
 */
export async function authenticate(request: Request, env: Env): Promise<{ email: string } | null> {
  if (env.ACCESS_DISABLED === "true") return { email: "dev@localhost" };
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return null;

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const [h, p, sig] = token?.split(".") ?? [];
  if (!h || !p || !sig) return null;

  try {
    const header = decodeJson(h) as { kid: string; alg: string };
    const claims = decodeJson(p) as { aud: string[]; iss: string; exp: number; email?: string };
    if (header.alg !== "RS256") return null;

    let jwk = (await getKeys(env.TEAM_DOMAIN)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await getKeys(env.TEAM_DOMAIN, true)).find((k) => k.kid === header.kid); // key rotation
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return null;

    if (claims.iss !== `https://${env.TEAM_DOMAIN}`) return null;
    if (!claims.aud?.includes(env.POLICY_AUD)) return null;
    if (claims.exp * 1000 < Date.now()) return null;
    return { email: claims.email ?? "service-token" };
  } catch {
    return null;
  }
}
