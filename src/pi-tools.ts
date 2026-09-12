import { spawn } from "node:child_process";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { sanitizeExecutionEnvironment } from "./security.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
  sandbox?: string;
  envAllowlist?: readonly string[];
  isPathProtected?: (path: string) => boolean;
}

export interface ReadManyToolInput {
  files: Array<ReadToolInput & { readRoots?: string[]; displayPath?: string }>;
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
  const tool = createReadTool(context.cwd);

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function readManyFilesTool(input: ReadManyToolInput, context: ToolContext): Promise<ToolResponse> {
  const results = await Promise.all(input.files.map((file) => {
    const { readRoots, displayPath: _displayPath, ...readInput } = file;
    return readFileTool(readInput, { ...context, readRoots: readRoots ?? context.readRoots });
  }));
  const content: McpContent[] = [];
  let hasError = false;

  results.forEach((result, index) => {
    const file = input.files[index];
    content.push({ type: "text", text: `--- ${file?.displayPath ?? file?.path ?? "file"} ---` });
    content.push(...result.content);
    hasError ||= Boolean(result.isError);
  });

  return {
    content,
    isError: hasError || undefined,
  };
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createGrepTool(context.cwd);
  const response = await runTool((params) => tool.execute("grep_files", params), input, context);
  if (!context.isPathProtected) return response;

  return {
    ...response,
    content: response.content.map((item) => {
      if (item.type !== "text") return item;
      const lines = item.text.split(/\r?\n/u).filter((line) => {
        const match = line.match(/^(.+?):\d+(?::\d+)?:/u);
        if (!match?.[1]) return true;
        try {
          const path = resolveAllowedPath(match[1], context.cwd, [context.root]);
          return !context.isPathProtected?.(path);
        } catch {
          return false;
        }
      });
      return { ...item, text: lines.join("\n") };
    }),
  };
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createFindTool(context.cwd);

  return runTool((params) => tool.execute("find_files", params), input, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), input, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);
  if (context.sandbox) {
    return runSandboxShell(
      input.command,
      timeout,
      context.cwd,
      context.sandbox,
      context.envAllowlist,
    );
  }
  return runHostShell(input.command, timeout, context.cwd, context.envAllowlist);
}

const MAX_SHELL_OUTPUT_BYTES = 2 * 1024 * 1024;

export function sandboxShellArgs(sandbox: string, cwd: string, command: string, timeoutSeconds: number): string[] {
  return [
    "exec",
    "-w",
    cwd,
    sandbox,
    "/usr/bin/timeout",
    "--signal=TERM",
    "--kill-after=2s",
    `${timeoutSeconds}s`,
    "/bin/bash",
    "-lc",
    command,
  ];
}

export function sandboxShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  allowlist: readonly string[] = [],
): NodeJS.ProcessEnv {
  return sanitizeExecutionEnvironment(env, allowlist);
}

function runHostShell(
  command: string,
  timeoutSeconds: number,
  cwd: string,
  envAllowlist: readonly string[] = [],
): Promise<ToolResponse> {
  return new Promise((resolvePromise) => {
    const environment = sanitizeExecutionEnvironment(process.env, envAllowlist);
    const shell = resolveShellCommand(command, process.platform, environment);
    const detached = process.platform !== "win32";
    const child = spawn(shell.executable, shell.args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (result: ToolResponse) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const append = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const remaining = MAX_SHELL_OUTPUT_BYTES - current;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return current + chunk.byteLength;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM", detached);
      killTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL", detached), 2_000);
      killTimer.unref();
    }, timeoutSeconds * 1_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish({ content: formatToolError(error), isError: true });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const parts: string[] = [];
      const stdoutText = Buffer.concat(stdout).toString("utf8").trimEnd();
      const stderrText = Buffer.concat(stderr).toString("utf8").trimEnd();
      if (stdoutText) parts.push(stdoutText);
      if (stdoutBytes > MAX_SHELL_OUTPUT_BYTES) parts.push(`[stdout truncated at ${MAX_SHELL_OUTPUT_BYTES} bytes]`);
      if (stderrText) parts.push(`[stderr]\n${stderrText}`);
      if (stderrBytes > MAX_SHELL_OUTPUT_BYTES) parts.push(`[stderr truncated at ${MAX_SHELL_OUTPUT_BYTES} bytes]`);
      if (timedOut) parts.push("Command timed out.");
      else if (code !== 0) parts.push(`Command exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`);
      finish({
        content: [{ type: "text", text: parts.join("\n\n") || "Command completed with no output." }],
        isError: timedOut || code !== 0 || undefined,
      });
    });
  });
}

function runSandboxShell(
  command: string,
  timeoutSeconds: number,
  cwd: string,
  sandbox: string,
  envAllowlist: readonly string[] = [],
): Promise<ToolResponse> {
  return new Promise((resolvePromise) => {
    const child = spawn("sbx", sandboxShellArgs(sandbox, cwd, command, timeoutSeconds), {
      env: sandboxShellEnvironment(process.env, envAllowlist),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const finish = (result: ToolResponse) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const append = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const remaining = MAX_SHELL_OUTPUT_BYTES - current;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return current + chunk.byteLength;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, (timeoutSeconds + 5) * 1_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ content: formatToolError(error), isError: true });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const parts: string[] = [];
      const stdoutText = Buffer.concat(stdout).toString("utf8").trimEnd();
      const stderrText = Buffer.concat(stderr).toString("utf8").trimEnd();
      if (stdoutText) parts.push(stdoutText);
      if (stdoutBytes > MAX_SHELL_OUTPUT_BYTES) parts.push(`[stdout truncated at ${MAX_SHELL_OUTPUT_BYTES} bytes]`);
      if (stderrText) parts.push(`[stderr]\n${stderrText}`);
      if (stderrBytes > MAX_SHELL_OUTPUT_BYTES) parts.push(`[stderr truncated at ${MAX_SHELL_OUTPUT_BYTES} bytes]`);
      if (timedOut) parts.push("Sandbox command timed out.");
      else if (code !== 0) parts.push(`Sandbox command exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`);
      finish({
        content: [{ type: "text", text: parts.join("\n\n") || "Sandbox command completed with no output." }],
        isError: timedOut || code !== 0 || undefined,
      });
    });
  });
}
