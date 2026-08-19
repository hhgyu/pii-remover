/**
 * Which URLs count as PII.
 *
 * `private_url` means *private* URL. Whether a link is private is not a
 * function of how famous its domain is — it is a function of whether a stranger
 * can open it. Enumerating the public web would be unmaintainable and every
 * host missing from that list would be a fresh false positive, so this
 * enumerates the opposite: what makes a URL non-public. Credentials baked into
 * it, a host that only resolves inside a network, or a tenant workspace that
 * demands a login. Everything else passes through unmasked.
 *
 * The cost of that inversion, stated plainly: an internal URL on an ordinary
 * public-looking domain (`https://admin.example.com/users/1234`) is no longer
 * masked by default. `extraPrivateSuffixes` adds such domains, and
 * `policy: "strict"` restores the previous mask-every-URL behaviour.
 *
 * Mirrored in `packages/backend/server/detection_policy.py` and locked by
 * `tests/fixtures/url-policy.json`. Change one side, change both.
 */

export type UrlPolicy = "heuristic" | "strict";

/**
 * Hosts whose content is gated behind a login, or that never leave a private
 * network. Matched as an exact host or as a parent suffix, so `atlassian.net`
 * also covers `acme.atlassian.net`.
 */
export const PRIVATE_HOST_SUFFIXES: ReadonlySet<string> = new Set([
  // Reserved / internal-only namespaces (RFC 6762, RFC 8375, RFC 2606).
  "internal",
  "intranet",
  "corp",
  "lan",
  "local",
  "localdomain",
  "home.arpa",
  "test",
  "invalid",
  "localhost",
  // Tunnels: a public hostname pointing at someone's laptop.
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "trycloudflare.com",
  "loca.lt",
  "localtunnel.me",
  "serveo.net",
  "pagekite.me",
  "telebit.io",
  "devtunnels.ms",
  "github.dev",
  // Tenant workspaces: the hostname itself names the organisation, and the
  // content behind it needs an account.
  "atlassian.net",
  "sharepoint.com",
  "onedrive.live.com",
  "teams.microsoft.com",
  "slack.com",
  "okta.com",
  "oktapreview.com",
  "auth0.com",
  "service-now.com",
  "servicenow.com",
  "zendesk.com",
  "freshdesk.com",
  "lightning.force.com",
  "my.salesforce.com",
  "notion.so",
  "docs.google.com",
  "drive.google.com",
  "dropbox.com",
  "box.com",
]);

/**
 * Query parameters that carry a credential or a signature. Their presence makes
 * a URL private regardless of host — a presigned S3 link lives on
 * `amazonaws.com`, which is as public a domain as they come.
 */
export const CREDENTIAL_QUERY_KEYS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "session",
  "sessionid",
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "sas",
]);

const URL_RE =
  /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/;

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface IsPrivateUrlOptions {
  readonly policy?: UrlPolicy;
  /** Extra hosts to treat as private. `*.acme.com`, `.acme.com` and `acme.com`
   *  are all accepted because operators write all three. */
  readonly extraPrivateSuffixes?: Iterable<string>;
}

export function normaliseHostSuffix(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\*/, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

export function hostMatches(host: string, suffixes: Iterable<string>): boolean {
  for (const suffix of suffixes) {
    if (!suffix) continue;
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

function hasCredentialParam(query: string): boolean {
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const key = (pair.split("=", 1)[0] ?? "").trim().toLowerCase();
    if (CREDENTIAL_QUERY_KEYS.has(key)) return true;
  }
  return false;
}

/**
 * True when `url` should be treated as PII and masked. Every rule below is an
 * independent reason to consider the URL private; the order matches the Python
 * port so a parity fixture can drive both.
 */
export function isPrivateUrl(
  url: string,
  opts: IsPrivateUrlOptions = {},
): boolean {
  const match = URL_RE.exec(url.trim());
  if (match === null) return false;

  const scheme = (match[1] ?? "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return false;
  if ((opts.policy ?? "heuristic") === "strict") return true;

  const authority = match[2] ?? "";
  // userinfo — https://user:pass@host/… is a credential in plain sight.
  if (authority.includes("@")) return true;
  // Bracketed IPv6 literal. No public site is addressed this way in prose.
  if (authority.startsWith("[")) return true;

  const host = (authority.split(":", 1)[0] ?? "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (host === "") return true;
  if (IPV4_RE.test(host)) return true;
  // A single-label host resolves only through a local search domain or
  // /etc/hosts: http://jenkins/job/deploy, http://localhost:3000.
  if (!host.includes(".")) return true;
  if (hostMatches(host, PRIVATE_HOST_SUFFIXES)) return true;

  const extra = opts.extraPrivateSuffixes;
  if (extra !== undefined) {
    const normalised: string[] = [];
    for (const suffix of extra) normalised.push(normaliseHostSuffix(suffix));
    if (hostMatches(host, normalised)) return true;
  }

  return hasCredentialParam(match[4] ?? "");
}
