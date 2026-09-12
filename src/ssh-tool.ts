import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { ToolResponse } from "./pi-tools.js";

export interface SshHostConfig {
  name: string;
  aliases?: string[];
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  tier?: "standard" | "admin";
}

export interface SshToolInput {
  host: string;
  command: string;
  timeout?: number;
}

interface SshProcessResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface SshAdminUnlockStatus {
  unlocked: boolean;
  expiresAt?: number;
  remainingSeconds: number;
}

export type SshAdminPolicy = "direct" | "timed-unlock";

export interface SshSecurityOptions {
  adminPolicy?: SshAdminPolicy;
  adminUnlockPath?: string;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const HOST_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const SSH_TARGET_PART_PATTERN = /^[^\s\p{Cc}@-][^\s\p{Cc}@]*$/u;

export function normalizeSshHosts(hosts: SshHostConfig[]): SshHostConfig[] {
  const names = new Set<string>();

  return hosts.map((host) => {
    const name = host.name.trim();
    const hostname = host.host.trim();
    const aliases = (host.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
    const user = host.user?.trim();
    const identityFile = host.identityFile?.trim();
    const tier = host.tier ?? "standard";

    if (!name) throw new Error("SSH host name must not be empty.");
    if (!HOST_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid SSH host name: ${name}. Use letters, numbers, dots, dashes, or underscores.`);
    }
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`Duplicate SSH host name: ${name}`);
    names.add(normalizedName);
    for (const alias of aliases) {
      if (!HOST_NAME_PATTERN.test(alias)) throw new Error(`Invalid SSH alias for ${name}: ${alias}`);
      const normalizedAlias = alias.toLowerCase();
      if (names.has(normalizedAlias)) {
        throw new Error(`Duplicate SSH alias for ${name}: ${alias}`);
      }
      names.add(normalizedAlias);
    }

    if (!hostname) throw new Error(`SSH host ${name} must define host.`);
    if (!SSH_TARGET_PART_PATTERN.test(hostname)) {
      throw new Error(`Invalid SSH host target for ${name}: ${hostname}`);
    }
    if (user && !SSH_TARGET_PART_PATTERN.test(user)) {
      throw new Error(`Invalid SSH user for ${name}: ${user}`);
    }
    if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)) {
      throw new Error(`Invalid SSH port for ${name}: ${host.port}`);
    }
    if (tier !== "standard" && tier !== "admin") {
      throw new Error(`Invalid SSH tier for ${name}: ${String(tier)}`);
    }

    return {
      name,
      ...(aliases.length > 0 ? { aliases } : {}),
      host: hostname,
      ...(user ? { user } : {}),
      ...(host.port !== undefined ? { port: host.port } : {}),
      ...(identityFile ? { identityFile: resolve(expandHomePath(identityFile)) } : {}),
      ...(tier === "admin" ? { tier } : {}),
    };
  });
}

export function sshAdminUnlockStatus(filePath: string, now = Math.floor(Date.now() / 1000)): SshAdminUnlockStatus {
  if (!existsSync(filePath)) return { unlocked: false, remainingSeconds: 0 };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { expiresAt?: unknown };
    if (!Number.isInteger(parsed.expiresAt)) return { unlocked: false, remainingSeconds: 0 };
    const expiresAt = parsed.expiresAt as number;
    const remainingSeconds = Math.max(0, expiresAt - now);
    return { unlocked: remainingSeconds > 0, expiresAt, remainingSeconds };
  } catch {
    return { unlocked: false, remainingSeconds: 0 };
  }
}

export function unlockSshAdmin(filePath: string, minutes: number, now = Math.floor(Date.now() / 1000)): number {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 15) {
    throw new Error("Admin SSH unlock duration must be between 1 and 15 minutes.");
  }
  const expiresAt = now + minutes * 60;
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = join(dirname(filePath), `.ssh-admin-unlock.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify({ expiresAt }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, filePath);
  chmodSync(filePath, 0o600);
  return expiresAt;
}

export function lockSshAdmin(filePath: string): void {
  rmSync(filePath, { force: true });
}

export function sshArgsForHost(host: SshHostConfig, command: string): string[] {
  const destination = host.user ? `${host.user}@${host.host}` : host.host;
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
  ];

  if (host.port !== undefined) args.push("-p", String(host.port));
  if (host.identityFile) {
    if (process.platform === "darwin") args.push("-o", "UseKeychain=yes");
    args.push("-o", "IdentitiesOnly=yes", "-i", resolve(expandHomePath(host.identityFile)));
  }

  args.push("--", destination, command);
  return args;
}

export function resolveSshHost(input: string, hosts: SshHostConfig[]): SshHostConfig | undefined {
  const requestedHost = input.trim().toLowerCase();
  return normalizeSshHosts(hosts).find((entry) =>
    entry.name.toLowerCase() === requestedHost ||
    (entry.aliases ?? []).some((alias) => alias.toLowerCase() === requestedHost)
  );
}

export async function runSshTool(
  input: SshToolInput,
  hosts: SshHostConfig[],
  security: SshSecurityOptions = {},
): Promise<ToolResponse> {
  try {
    if (hosts.length === 0) {
      throw new Error("No SSH hosts are configured. Add sshHosts entries to ~/.devspace/config.json first.");
    }

    const normalizedHosts = normalizeSshHosts(hosts);
    const host = resolveSshHost(input.host, normalizedHosts);
    if (!host) {
      const configured = normalizedHosts.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]).join(", ");
      throw new Error(`SSH host is not configured: ${input.host}. Configured hosts: ${configured}`);
    }
    if (host.tier === "admin" && (security.adminPolicy ?? "timed-unlock") === "timed-unlock") {
      const status = security.adminUnlockPath
        ? sshAdminUnlockStatus(security.adminUnlockPath)
        : { unlocked: false };
      if (!status.unlocked) {
        throw new Error(
          `SSH host ${host.name} is admin-tier and locally locked. Run in a Mac terminal: devspace ssh unlock-admin --minutes 15`,
        );
      }
    }

    validateSshCommand(input.command);
    const timeoutSeconds = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);
    const result = await runSshProcess(sshArgsForHost(host, input.command), timeoutSeconds);

    return {
      content: [{ type: "text", text: formatSshOutput(result) }],
      isError: result.timedOut || result.exitCode !== 0 || undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function validateSshCommand(command: string): void {
  if (!command.trim()) throw new Error("SSH command must not be empty.");
  if (command.includes("\0")) throw new Error("SSH command must not contain NUL bytes.");
}

function runSshProcess(args: string[], timeoutSeconds: number): Promise<SshProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = appendOutput(stdoutChunks, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = appendOutput(stderrChunks, chunk, stderrBytes);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdoutTruncated: stdoutBytes > MAX_OUTPUT_BYTES,
        stderrTruncated: stderrBytes > MAX_OUTPUT_BYTES,
        exitCode,
        signal,
        timedOut,
      });
    });
  });
}

function appendOutput(chunks: Buffer[], chunk: Buffer, currentBytes: number): number {
  const remaining = MAX_OUTPUT_BYTES - currentBytes;
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return currentBytes + chunk.byteLength;
}

function formatSshOutput(result: SshProcessResult): string {
  const parts: string[] = [];
  if (result.stdout.trimEnd()) parts.push(result.stdout.trimEnd());
  if (result.stdoutTruncated) parts.push(`[stdout truncated at ${MAX_OUTPUT_BYTES} bytes]`);
  if (result.stderr.trimEnd()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
  if (result.stderrTruncated) parts.push(`[stderr truncated at ${MAX_OUTPUT_BYTES} bytes]`);

  if (result.timedOut) {
    parts.push("SSH command timed out.");
  } else if (result.exitCode !== 0) {
    parts.push(`SSH command exited with code ${result.exitCode ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}.`);
  }

  return parts.join("\n\n") || "SSH command completed with no output.";
}
