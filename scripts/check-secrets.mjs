import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const forbiddenBasenames = new Set([
  ".env",
  "auth.json",
  "ssh-admin-unlock.json",
  "oauth-clients.json",
  "oauth-refresh-tokens.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const forbiddenNamePatterns = [
  /^\.devspace-(?:credential|secret)-.*\.tmp$/i,
  /-password\.tmp$/i,
];
const forbiddenExtensions = [".pem", ".p12", ".pfx", ".key"];
const secretPatterns = [
  ["private-key-header", /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ["stripe-live-secret", /\bsk_live_[0-9A-Za-z]{20,}\b/],
  ["openai-secret", /\bsk-(?:proj-)?[0-9A-Za-z_-]{24,}\b/],
];

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
  encoding: "utf8",
}).split("\0").filter(Boolean);
const findings = [];

for (const path of files) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    continue;
  }
  if (!stats.isFile()) continue;

  const name = basename(path);
  if (
    forbiddenBasenames.has(name) ||
    forbiddenNamePatterns.some((pattern) => pattern.test(name)) ||
    forbiddenExtensions.some((extension) => name.endsWith(extension))
  ) {
    findings.push({ path, rule: "forbidden-secret-filename" });
    continue;
  }

  let content;
  try {
    const buffer = readFileSync(path);
    if (buffer.includes(0)) continue;
    content = buffer.toString("utf8");
  } catch {
    continue;
  }

  for (const [rule, pattern] of secretPatterns) {
    if (pattern.test(content)) findings.push({ path, rule });
  }
}

if (findings.length > 0) {
  console.error("Secret scan failed. Potential sensitive material detected; matched values are intentionally not printed.");
  for (const finding of findings) console.error(`- ${finding.path}: ${finding.rule}`);
  process.exit(1);
}

console.log(`Secret scan passed (${files.length} tracked/unignored files checked).`);
