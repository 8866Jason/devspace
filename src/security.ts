import { opendir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { AccessDeniedError } from "./roots.js";

const PROTECTED_DIRECTORY_NAMES = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
]);

const PROTECTED_FILE_NAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "application_default_credentials.json",
  "auth.json",
  "credentials.json",
  "service-account.json",
  "wp-config.php",
]);

const PROTECTED_FILE_EXTENSIONS = new Set([
  ".jks",
  ".key",
  ".p12",
  ".pfx",
  ".pem",
]);

const SCAN_SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".turbo",
  "build",
  "dist",
  "node_modules",
  "vendor",
]);

const LOG_SECRET_ASSIGNMENT = /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential)\b(\s*[=:]\s*)([^\s,;]+)/gi;
const LOG_BEARER_TOKEN = /(\bBearer\s+)([A-Za-z0-9._~+\/-]+=*)/gi;
const LOG_BASIC_AUTH_URL = /(https?:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;
const NEVER_FORWARD_ENV_NAMES = new Set([
  "DEVSPACE_OAUTH_OWNER_TOKEN",
  "SSH_AUTH_SOCK",
]);

interface RateLimitBucket {
  windowStartedAt: number;
  count: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Rate limit must be a positive integer.");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error("Rate-limit window must be a positive integer.");
  }

  consume(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const existing = this.buckets.get(key);
    const expired = !existing || now - existing.windowStartedAt >= this.windowMs;
    const bucket = expired
      ? { windowStartedAt: now, count: 0 }
      : existing;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    this.prune(now);

    const remainingMs = Math.max(0, this.windowMs - (now - bucket.windowStartedAt));
    return {
      allowed: bucket.count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)),
    };
  }

  private prune(now: number): void {
    if (this.buckets.size < 1_024) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStartedAt >= this.windowMs) this.buckets.delete(key);
    }
  }
}

export function isProtectedWorkspacePath(path: string, workspaceRoot: string): boolean {
  const root = resolve(workspaceRoot);
  const target = resolve(path);
  const relationship = relative(root, target);
  if (
    relationship === ""
    || relationship === ".."
    || relationship.startsWith("../")
    || relationship.startsWith("..\\")
  ) {
    return false;
  }

  const parts = relationship.split(/[\\/]+/u).filter(Boolean);
  if (parts.some((part) => PROTECTED_DIRECTORY_NAMES.has(part.toLowerCase()))) return true;

  const normalized = relationship.replaceAll("\\", "/").toLowerCase();
  if (normalized === ".trigger-tree/history.jsonl" || normalized.startsWith(".trigger-tree/sessions/")) {
    return true;
  }

  const fileName = basename(target).toLowerCase();
  if (fileName === ".env") return true;
  if (
    fileName.startsWith(".env.")
    && ![".env.example", ".env.sample", ".env.template", ".env.dist"].includes(fileName)
  ) {
    return true;
  }
  if (PROTECTED_FILE_NAMES.has(fileName)) return true;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/iu.test(fileName)) return true;
  return PROTECTED_FILE_EXTENSIONS.has(extname(fileName));
}

export function assertWorkspacePathNotProtected(
  path: string,
  workspaceRoot: string,
  displayPath = path,
): string {
  if (isProtectedWorkspacePath(path, workspaceRoot)) {
    throw new AccessDeniedError(
      `Protected workspace secret path cannot be accessed through DevSpace: ${displayPath}`,
    );
  }
  return path;
}

export async function findProtectedWorkspacePath(workspaceRoot: string): Promise<string | undefined> {
  const root = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot));

  const visit = async (directory: string): Promise<string | undefined> => {
    let entries;
    try {
      entries = await opendir(directory);
    } catch {
      return undefined;
    }

    for await (const entry of entries) {
      const path = join(directory, entry.name);
      if (isProtectedWorkspacePath(path, root)) return path;
      if (
        entry.isDirectory()
        && !entry.isSymbolicLink()
        && !SCAN_SKIPPED_DIRECTORY_NAMES.has(entry.name)
      ) {
        const nested = await visit(path);
        if (nested) return nested;
      }
    }
    return undefined;
  };

  return visit(root);
}

export function parseEnvironmentAllowlist(value: string | undefined): string[] {
  return Array.from(new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry)),
  ));
}

export function sanitizeExecutionEnvironment(
  env: NodeJS.ProcessEnv,
  allowedSensitiveNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set(allowedSensitiveNames);
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (NEVER_FORWARD_ENV_NAMES.has(key.toUpperCase())) continue;
    if (key.startsWith("DEVSPACE_") && !allowed.has(key)) continue;
    if (isSensitiveEnvironmentName(key) && !allowed.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

export function isSensitiveEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper === "SSH_AUTH_SOCK") return true;
  if ([
    "DATABASE_URL",
    "MONGODB_URI",
    "MYSQL_URL",
    "POSTGRES_URL",
    "REDIS_URL",
  ].includes(upper)) return true;
  return /(?:^|_)(?:API_?KEY|ACCESS_?KEY|AUTH|COOKIE|CREDENTIALS?|PASS(?:WORD|WD)?|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(?:_|$)/u.test(upper);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(LOG_BEARER_TOKEN, "$1[redacted]")
    .replace(LOG_SECRET_ASSIGNMENT, "$1$2[redacted]")
    .replace(LOG_BASIC_AUTH_URL, "$1[redacted]$3");
}

export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      isSensitiveLogKey(key) ? "[redacted]" : sanitizeLogValue(value),
    ]),
  );
}

function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (value && typeof value === "object") {
    return sanitizeLogFields(value as Record<string, unknown>);
  }
  return value;
}

function isSensitiveLogKey(key: string): boolean {
  return isSensitiveEnvironmentName(key)
    || /(?:authorization|owner.?token|client.?secret)/iu.test(key);
}
