import type { Detection } from "../types.js";
import { TOKEN_STRICT_PATTERN } from "../token/format.js";

const AWS_ACCESS_KEY_REGEX = /(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}(?=[^A-Za-z0-9]|$)/g;

const GITHUB_PAT_REGEX = /(?:^|[^A-Za-z0-9])ghp_[A-Za-z0-9]{36,}(?=[^A-Za-z0-9]|$)/g;

const OPENAI_KEY_REGEX = /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9]|$)/g;

const PEM_PRIVATE_KEY_REGEX =
  /-----BEGIN [A-Z0-9 -]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 -]*PRIVATE KEY-----/g;

const JWT_REGEX =
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

const CONNECTION_STRING_REGEX =
  /[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi;

const NPM_TOKEN_REGEX =
  /(?:\/\/[^/\s]+\/:_authToken=|_authToken=)[A-Za-z0-9_-]{8,}/g;

const ANTHROPIC_KEY_REGEX =
  /(?:^|[^A-Za-z0-9])sk-ant-api03-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9]|$)/g;

const GOOGLE_API_KEY_REGEX =
  /(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{35}(?=[^A-Za-z0-9]|$)/g;

const SLACK_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9])xox[bpak]-[A-Za-z0-9-]{10,}(?=[^A-Za-z0-9-]|$)/g;

const STRIPE_KEY_REGEX =
  /(?:^|[^A-Za-z0-9])[sr]k_(?:live|test|prod)_[A-Za-z0-9]{20,}(?=[^A-Za-z0-9]|$)/g;

const GITLAB_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-]|$)/g;

const TELEGRAM_BOT_TOKEN_REGEX =
  /(?:^|[^0-9])[1-9]\d{5,9}:[A-Za-z0-9_-]{35}(?=[^A-Za-z0-9_-]|$)/g;

const GITHUB_FINE_GRAINED_PAT_REGEX =
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}(?=[^A-Za-z0-9_]|$)/g;

const GITHUB_OAUTH_REGEX =
  /(?:^|[^A-Za-z0-9])gho_[A-Za-z0-9]{20,}(?=[^A-Za-z0-9]|$)/g;

const GITHUB_USER_TO_SERVER_REGEX =
  /(?:^|[^A-Za-z0-9])ghu_[A-Za-z0-9]{20,}(?=[^A-Za-z0-9]|$)/g;

const GITHUB_SERVER_TO_SERVER_REGEX =
  /(?:^|[^A-Za-z0-9])ghs_[A-Za-z0-9]{20,}(?=[^A-Za-z0-9]|$)/g;

const GITHUB_REFRESH_REGEX =
  /(?:^|[^A-Za-z0-9])ghr_[A-Za-z0-9]{20,}(?=[^A-Za-z0-9]|$)/g;

const SENDGRID_KEY_REGEX =
  /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g;

const DIGITALOCEAN_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9])do[opr]_v1_[a-f0-9]{64}(?=[^a-f0-9]|$)/g;

const TWILIO_ACCOUNT_SID_REGEX =
  /(?:^|[^A-Za-z0-9])AC[a-f0-9]{32}(?=[^a-f0-9]|$)/gi;

const TWILIO_API_KEY_REGEX =
  /(?:^|[^A-Za-z0-9])SK[a-zA-Z0-9]{32}(?=[^A-Za-z0-9]|$)/g;

const SHOPIFY_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9])shp(?:at|pa|ca|ss)_[a-f0-9]{32}(?=[^a-f0-9]|$)/g;

const POSTMAN_KEY_REGEX =
  /PMAK-[A-Za-z0-9-]{59}/g;

const DISCORD_BOT_TOKEN_REGEX =
  /[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27}/g;

const DATABRICKS_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9])dapi[a-h0-9]{32}(?=[^A-Za-z0-9]|$)/g;

const PYPI_TOKEN_REGEX =
  /pypi-AgEI[A-Za-z0-9_-]{50,}/g;

const MAILGUN_KEY_REGEX =
  /(?:^|[^A-Za-z0-9])key-[a-z0-9]{32}(?=[^a-z0-9]|$)/g;

const HUGGINGFACE_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9_-])hf_[A-Za-z]{34}(?=[^A-Za-z0-9_-]|$)/g;

const VERCEL_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9_-])vc[pcari]_[A-Za-z0-9]{20,60}(?=[^A-Za-z0-9_-]|$)/g;

const NOTION_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9_-])ntn_[0-9]{11}[A-Za-z0-9]{32}[A-Za-z0-9]{3}(?=[^A-Za-z0-9_-]|$)/g;

const LINEAR_KEY_REGEX =
  /(?:^|[^A-Za-z0-9_-])lin_api_[A-Za-z0-9]{40}(?=[^A-Za-z0-9_-]|$)/g;

const NPM_GRANULAR_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9_-])npm_[A-Za-z0-9]{36}(?=[^A-Za-z0-9_-]|$)/g;

const CLOUDFLARE_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9_-])cf(?:k|ut|at)_[A-Za-z0-9-]{40}[A-Fa-f0-9]{8}(?=[^A-Za-z0-9_-]|$)/g;

// Legacy Supabase anon/service keys are JWT-shaped (eyJ...) → already JWT_REGEX.
const SUPABASE_PUBLISHABLE_KEY_REGEX =
  /(?:^|[^A-Za-z0-9_-])sb_publishable_[A-Za-z0-9_-]{16,}(?=[^A-Za-z0-9_-]|$)/g;

const SUPABASE_SECRET_KEY_REGEX =
  /(?:^|[^A-Za-z0-9_-])sb_secret_[A-Za-z0-9_-]{16,}(?=[^A-Za-z0-9_-]|$)/g;

export const SECRET_PATTERNS: readonly {
  regex: RegExp;
  label: string;
  validate?: (match: string) => boolean;
}[] = [
  { regex: SUPABASE_PUBLISHABLE_KEY_REGEX, label: "supabase_publishable_key" },
  { regex: SUPABASE_SECRET_KEY_REGEX, label: "supabase_secret_key" },
  { regex: AWS_ACCESS_KEY_REGEX, label: "aws_access_key" },
  { regex: GITHUB_PAT_REGEX, label: "github_pat" },
  { regex: OPENAI_KEY_REGEX, label: "openai_api_key" },
  { regex: ANTHROPIC_KEY_REGEX, label: "anthropic_api_key" },
  { regex: GOOGLE_API_KEY_REGEX, label: "google_api_key" },
  { regex: SLACK_TOKEN_REGEX, label: "slack_token" },
  { regex: STRIPE_KEY_REGEX, label: "stripe_key" },
  { regex: GITLAB_TOKEN_REGEX, label: "gitlab_token" },
  { regex: TELEGRAM_BOT_TOKEN_REGEX, label: "telegram_bot_token" },
  { regex: PEM_PRIVATE_KEY_REGEX, label: "pem_private_key" },
  { regex: JWT_REGEX, label: "jwt_token" },
  { regex: CONNECTION_STRING_REGEX, label: "connection_string_password", validate: hasCredentials },
  { regex: NPM_TOKEN_REGEX, label: "npm_token" },
  { regex: GITHUB_FINE_GRAINED_PAT_REGEX, label: "github_fine_grained_pat" },
  { regex: GITHUB_OAUTH_REGEX, label: "github_oauth_token" },
  { regex: GITHUB_USER_TO_SERVER_REGEX, label: "github_user_to_server" },
  { regex: GITHUB_SERVER_TO_SERVER_REGEX, label: "github_server_to_server" },
  { regex: GITHUB_REFRESH_REGEX, label: "github_refresh_token" },
  { regex: SENDGRID_KEY_REGEX, label: "sendgrid_api_key" },
  { regex: DIGITALOCEAN_TOKEN_REGEX, label: "digitalocean_token" },
  { regex: TWILIO_ACCOUNT_SID_REGEX, label: "twilio_account_sid" },
  { regex: TWILIO_API_KEY_REGEX, label: "twilio_api_key" },
  { regex: SHOPIFY_TOKEN_REGEX, label: "shopify_token" },
  { regex: POSTMAN_KEY_REGEX, label: "postman_api_key" },
  { regex: DISCORD_BOT_TOKEN_REGEX, label: "discord_bot_token" },
  { regex: DATABRICKS_TOKEN_REGEX, label: "databricks_token" },
  { regex: PYPI_TOKEN_REGEX, label: "pypi_token" },
  { regex: MAILGUN_KEY_REGEX, label: "mailgun_api_key" },
  { regex: HUGGINGFACE_TOKEN_REGEX, label: "huggingface_token" },
  { regex: VERCEL_TOKEN_REGEX, label: "vercel_token" },
  { regex: NOTION_TOKEN_REGEX, label: "notion_token" },
  { regex: LINEAR_KEY_REGEX, label: "linear_api_key" },
  { regex: NPM_GRANULAR_TOKEN_REGEX, label: "npm_granular_token" },
  { regex: CLOUDFLARE_TOKEN_REGEX, label: "cloudflare_token" },
];

function hasCredentials(uri: string): boolean {
  const afterScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const atIndex = afterScheme.indexOf("@");
  if (atIndex < 0) return false;
  const userInfo = afterScheme.slice(0, atIndex);
  return userInfo.includes(":");
}

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const HEX_ONLY_REGEX = /^[A-Fa-f0-9]+$/;

// Our own masking tokens are high-entropy by construction; scanning them as
// secrets would re-tokenise an already-masked value. Non-global so `.test()`
// stays stateless across calls.
const OPF_TOKEN_REGEX = new RegExp(TOKEN_STRICT_PATTERN, "i");

const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  "your-key-here",
  "your_api_key",
  "changeme",
  "change-me",
  "example",
  "dummy",
  "test",
  "redacted",
  "placeholder",
  "none",
  "null",
  "undefined",
]);

function isHighEntropySecret(value: string): boolean {
  if (OPF_TOKEN_REGEX.test(value)) return false;
  if (PLACEHOLDER_VALUES.has(value.toLowerCase())) return false;
  if (/[<>${}]/.test(value)) return false;
  if (HEX_ONLY_REGEX.test(value)) {
    return value.length >= 32 && shannonEntropy(value) >= 3.2;
  }
  return value.length >= 24 && shannonEntropy(value) >= 4.0;
}

const BEARER_TOKEN_REGEX =
  /\b[Bb]earer\s+([A-Za-z0-9=~@.+/_-]{8,})/g;

const GENERIC_KEY_VALUE_REGEX =
  /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token)\b\s*[:=]\s*["']?([A-Za-z0-9=~@.+/_-]{16,})["']?/gi;

export interface FindSecretsOptions {
  /**
   * Enable generic key=value heuristics (api_key=, *_secret=, etc.).
   * Default false — high false-positive risk for a round-trip masking tool.
   */
  generic?: boolean;
}

export function findSecrets(
  text: string,
  options: FindSecretsOptions = {}
): Detection[] {
  const out: Detection[] = [];
  for (const { regex, validate } of SECRET_PATTERNS) {
    for (const m of text.matchAll(regex)) {
      const matchStart = m.index ?? 0;
      const full = m[0];
      // Boundary guard consumes one leading non-secret char — realign offset.
      const prefixLen = full.length - full.replace(/^[^A-Za-z0-9]?/, "").length;
      const secretStart = matchStart + prefixLen;
      const secretText = full.slice(prefixLen);
      if (validate && !validate(secretText)) continue;
      out.push({
        start: secretStart,
        end: secretStart + secretText.length,
        category: "secret",
        confidence: 0.99,
        text: secretText,
      });
    }
  }

  for (const m of text.matchAll(BEARER_TOKEN_REGEX)) {
    const token = m[1];
    if (token === undefined) continue;
    if (!isHighEntropySecret(token)) continue;
    const tokenStart = (m.index ?? 0) + m[0].length - token.length;
    out.push({
      start: tokenStart,
      end: tokenStart + token.length,
      category: "secret",
      confidence: 0.9,
      text: token,
    });
  }

  if (options.generic) {
    for (const m of text.matchAll(GENERIC_KEY_VALUE_REGEX)) {
      const value = m[2];
      if (value === undefined) continue;
      if (!isHighEntropySecret(value)) continue;
      const valueStart = (m.index ?? 0) + m[0].lastIndexOf(value);
      out.push({
        start: valueStart,
        end: valueStart + value.length,
        category: "secret",
        confidence: 0.85,
        text: value,
      });
    }
  }

  return out;
}
