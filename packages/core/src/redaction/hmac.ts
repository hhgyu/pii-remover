import { createHmac, hkdfSync } from "node:crypto";
import type { PIICategory } from "../types.js";
import { categoryToTokenLabel } from "../token/category-map.js";

const HKDF_SALT = "pii-remover-hmac-redaction-v1";
const HKDF_INFO = "hmac-tokenization-key";
const DERIVED_KEY_LENGTH = 32;
const DEFAULT_TOKEN_LENGTH = 16;

export function deriveHmacKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("deriveHmacKey: secret must be a non-empty string");
  }
  const derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    DERIVED_KEY_LENGTH,
  );
  return Buffer.from(derived);
}

export class HmacTokenizer {
  private readonly key: Buffer;
  private readonly tokenLength: number;

  constructor(secret: string, tokenLength: number = DEFAULT_TOKEN_LENGTH) {
    this.key = deriveHmacKey(secret);
    if (!Number.isInteger(tokenLength) || tokenLength < 4) {
      throw new Error("HmacTokenizer: tokenLength must be an integer >= 4");
    }
    this.tokenLength = tokenLength;
  }

  tokenize(category: PIICategory, text: string): string {
    const digest = createHmac("sha256", this.key)
      .update(text, "utf8")
      .digest("base64url")
      .slice(0, this.tokenLength);
    return `[${categoryToTokenLabel(category)}:${digest}]`;
  }
}
