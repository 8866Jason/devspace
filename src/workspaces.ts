import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type {
  WorkspaceConversationBinding,
  WorkspaceMode,
  WorkspaceStore,
} from "./workspace-store.js";
import { lstat, mkdir, opendir, readFile, realpath, rename, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree } from "./git-worktrees.js";
import {
  AccessDeniedError,
  assertAllowedPath,
  expandHomePath,
  isPathInsideRoot,
  resolveAllowedPath,
} from "./roots.js";
import {
  assertWorkspacePathNotProtected,
  findProtectedWorkspacePath,
  isProtectedWorkspacePath,
} from "./security.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";
import {
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";
import { transferWorkspace, type WorkspaceTransferResult } from "./workspace-transfer.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  agentProfiles: LocalAgentProfile[];
  activatedSkillDirs: Set<string>;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  workspaceReused: boolean;
  includeBootstrapContext: boolean;
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface WorkspaceMoveResult {
  source: string;
  destination: string;
  kind: "file" | "directory";
}

export interface WorkspaceRelocateResult extends WorkspaceTransferResult {
  workspaceId: string;
  targetWorkspaceId?: string;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
}

export interface OpenWorkspaceOptions {
  conversationScopeId?: string;
}

type PathStats = Stats;
type DirectoryOps = {
  stat: (path: string) => Promise<PathStats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly pendingCheckoutOpens = new Map<string, Promise<WorkspaceContext>>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(
    input: string | OpenWorkspaceInput,
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceContext> {
    const workspaceInput = typeof input === "string"
      ? { path: this.resolveWorkspacePath(input) }
      : { ...input, path: this.resolveWorkspacePath(input.path) };
    const conversationScopeId = openOptions.conversationScopeId;
    if (!conversationScopeId || !this.store) {
      return this.openNewWorkspace(workspaceInput);
    }

    const projectKey = await this.conversationProjectKey(workspaceInput);
    const mode = workspaceInput.mode ?? "checkout";
    if (mode === "worktree") {
      const context = await this.openWorktreeWorkspace(workspaceInput.path, workspaceInput.baseRef);
      return {
        ...context,
        // A new worktree always has its own workspace-specific context.
        includeBootstrapContext: true,
      };
    }

    const targetKey = this.conversationCheckoutTargetKey(projectKey);
    const operationKey = JSON.stringify([conversationScopeId, targetKey]);
    const pending = this.pendingCheckoutOpens.get(operationKey);
    if (pending) {
      const context = await pending;
      return {
        ...context,
        workspaceReused: true,
        includeBootstrapContext: false,
      };
    }

    const open = this.openConversationCheckout(
      workspaceInput,
      conversationScopeId,
      targetKey,
    );
    this.pendingCheckoutOpens.set(operationKey, open);

    try {
      return await open;
    } finally {
      if (this.pendingCheckoutOpens.get(operationKey) === open) {
        this.pendingCheckoutOpens.delete(operationKey);
      }
    }
  }

  private async openNewWorkspace(options: OpenWorkspaceInput): Promise<WorkspaceContext> {
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(options.path, options.baseRef);
    }

    return this.openCheckoutWorkspace(options.path);
  }

  private async openConversationCheckout(
    input: OpenWorkspaceInput,
    conversationScopeId: string,
    targetKey: string,
  ): Promise<WorkspaceContext> {
    const binding = this.store?.getConversationBinding(conversationScopeId, targetKey);
    if (binding) {
      const reusableWorkspace = await this.findReusableCheckoutWorkspace(binding);

      if (reusableWorkspace) {
        const context = await this.reusedWorkspaceContext(reusableWorkspace);
        this.store?.touchConversationBinding(conversationScopeId, targetKey);
        return {
          ...context,
          includeBootstrapContext: false,
        };
      }

      this.workspaces.delete(binding.workspaceSessionId);
      this.store?.deleteConversationBinding(conversationScopeId, targetKey);
    }

    const context = await this.openCheckoutWorkspace(input.path);
    this.store?.setConversationBinding({
      conversationScopeId,
      targetKey,
      workspaceSessionId: context.workspace.id,
    });
    return {
      ...context,
      includeBootstrapContext: true,
    };
  }

  private async findReusableCheckoutWorkspace(
    binding: WorkspaceConversationBinding,
  ): Promise<Workspace | undefined> {
    const session = this.store?.getSession(binding.workspaceSessionId);
    if (!session || session.status !== "active" || session.mode !== "checkout") {
      return undefined;
    }

    let root: string;
    try {
      root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
      const rootStats = await stat(root);
      if (!rootStats.isDirectory()) return undefined;
    } catch (error) {
      if (
        error instanceof AccessDeniedError ||
        (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      ) {
        return undefined;
      }

      throw error;
    }

    const workspace = this.getWorkspace(binding.workspaceSessionId);
    if (workspace.mode !== "checkout" || workspace.root !== root) return undefined;
    return workspace;
  }

  private async conversationProjectKey(input: OpenWorkspaceInput): Promise<string> {
    const path = assertAllowedPath(input.path, this.config.allowedRoots);
    return canonicalPath(path);
  }

  private conversationCheckoutTargetKey(projectKey: string): string {
    return JSON.stringify(["checkout", projectKey, null]);
  }

  private async reusedWorkspaceContext(workspace: Workspace): Promise<WorkspaceContext> {
    workspace.agentProfiles = await loadLocalAgentProfiles(this.config, workspace.root);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: true,
      includeBootstrapContext: true,
    };
  }

  async movePath(
    workspace: Workspace,
    sourceInput: string,
    destinationInput: string,
  ): Promise<WorkspaceMoveResult> {
    const source = this.resolvePath(workspace, sourceInput);
    const destination = this.resolvePath(workspace, destinationInput);
    this.assertMutationPathAllowed(workspace, source, sourceInput);
    this.assertMutationPathAllowed(workspace, destination, destinationInput);

    const canonicalRoot = await realpath(workspace.root);
    const sourceStats = await lstat(source).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Source does not exist: ${sourceInput}`);
      }
      throw error;
    });
    if (sourceStats.isSymbolicLink()) {
      throw new AccessDeniedError(`Moving symlinks is not supported: ${sourceInput}`);
    }
    if (!sourceStats.isFile() && !sourceStats.isDirectory()) {
      throw new Error(`Source must be a regular file or directory: ${sourceInput}`);
    }

    const canonicalSource = await realpath(source);
    if (!isPathInsideRoot(canonicalSource, canonicalRoot)) {
      throw new AccessDeniedError(`Source resolves outside the workspace root: ${sourceInput}`);
    }
    if (this.protectedRuntimePaths().some((path) => isPathInsideRoot(path, canonicalSource))) {
      throw new AccessDeniedError(`Moving a path that contains DevSpace credentials is not allowed: ${sourceInput}`);
    }

    const destinationExists = await lstat(destination)
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
    if (destinationExists) throw new Error(`Destination already exists: ${destinationInput}`);

    const canonicalDestinationParent = await realpath(dirname(destination)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Destination parent does not exist: ${destinationInput}`);
      }
      throw error;
    });
    const destinationParentStats = await stat(canonicalDestinationParent);
    if (!destinationParentStats.isDirectory()) {
      throw new Error(`Destination parent is not a directory: ${destinationInput}`);
    }
    if (!isPathInsideRoot(canonicalDestinationParent, canonicalRoot)) {
      throw new AccessDeniedError(`Destination resolves outside the workspace root: ${destinationInput}`);
    }

    const canonicalDestination = resolve(canonicalDestinationParent, basename(destination));
    if (sourceStats.isDirectory() && isPathInsideRoot(canonicalDestination, canonicalSource)) {
      throw new Error(`Destination cannot be inside the source directory: ${destinationInput}`);
    }

    await rename(source, destination);
    await lstat(source).then(
      () => { throw new Error(`Move verification failed; source still exists: ${sourceInput}`); },
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      },
    );
    await lstat(destination);

    return {
      source: sourceInput,
      destination: destinationInput,
      kind: sourceStats.isDirectory() ? "directory" : "file",
    };
  }

  async relocateWorkspace(
    workspace: Workspace,
    destinationInput: string,
    options: { removeSource: boolean; startDdev: boolean },
  ): Promise<WorkspaceRelocateResult> {
    const source = await realpath(workspace.root);
    const destination = resolve(expandHomePath(destinationInput));
    assertAllowedPath(destination, this.config.allowedRoots);
    if (isPathInsideRoot(destination, source)) {
      throw new Error("Destination cannot be inside the source workspace.");
    }
    if (this.protectedRuntimePaths().some((path) => isPathInsideRoot(path, source))) {
      throw new AccessDeniedError("A workspace containing DevSpace credentials cannot be relocated.");
    }

    const canonicalDestinationParent = await realpath(dirname(destination)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Destination parent does not exist: ${dirname(destination)}`);
      }
      throw error;
    });
    const canonicalAllowedRoots = await Promise.all(
      this.config.allowedRoots.map((root) => realpath(resolve(root)).catch(() => undefined)),
    );
    if (!canonicalAllowedRoots.some((root) => root && isPathInsideRoot(canonicalDestinationParent, root))) {
      throw new AccessDeniedError("Destination parent resolves outside configured allowed roots.");
    }

    const transfer = await transferWorkspace({
      source,
      destination,
      removeSource: options.removeSource,
      startDdev: options.startDdev,
    });

    let targetWorkspaceId: string | undefined;
    if (options.removeSource) {
      workspace.root = destination;
      const loadedSkills = this.loadSkillsForWorkspace(destination);
      workspace.skills = loadedSkills.skills;
      workspace.skillDiagnostics = loadedSkills.skillDiagnostics;
      workspace.agentProfiles = await loadLocalAgentProfiles(this.config, destination);
      workspace.activatedSkillDirs = new Set();
      this.store?.updateRoot(workspace.id, destination);
    } else {
      targetWorkspaceId = (await this.openNewWorkspace({ path: destination })).workspace.id;
    }

    return {
      ...transfer,
      workspaceId: workspace.id,
      targetWorkspaceId,
    };
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session) {
      throw new Error(
        `Unknown workspaceId: ${workspaceId}. Open the target project or worktree again and continue with the new workspaceId.`,
      );
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
      agentProfiles: [],
      activatedSkillDirs: new Set(),
    };
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);

    return restoredWorkspace;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }
    this.assertNotProtectedRuntimePath(absolutePath, inputPath);
    assertWorkspacePathNotProtected(absolutePath, workspace.root, inputPath);

    return absolutePath;
  }

  isProtectedWorkspacePath(workspace: Workspace, inputPath: string): boolean {
    return isProtectedWorkspacePath(resolve(workspace.root, inputPath), workspace.root);
  }

  resolveMutationPath(workspace: Workspace, inputPath: string): string {
    const absolutePath = this.resolvePath(workspace, inputPath);
    this.assertMutationPathAllowed(workspace, absolutePath, inputPath);
    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) throw workspaceError;

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    }
  }

  async assertShellWorkspaceSafe(workspace: Workspace): Promise<void> {
    this.assertShellAllowed(workspace);
    if (this.config.dangerouslyAllowShellInSecretWorkspaces) return;
    if (await findProtectedWorkspacePath(workspace.root)) {
      throw new AccessDeniedError(
        "Shell is disabled in workspaces containing protected secret files. Use an isolated worktree without local secrets, or explicitly enable the break-glass override for this trusted workflow.",
      );
    }
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    this.assertShellAllowed(workspace);
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  private resolveWorkspacePath(inputPath: string): string {
    const requested = inputPath.trim();
    const alias = requested.startsWith("@") ? requested.slice(1) : requested;
    return this.config.workspaceAliases[alias] ?? requested;
  }

  private assertMutationPathAllowed(workspace: Workspace, absolutePath: string, inputPath: string): void {
    if (isPathInsideRoot(absolutePath, join(workspace.root, ".git"))) {
      throw new AccessDeniedError(`Protected Git metadata cannot be modified: ${inputPath}`);
    }
    this.assertNotProtectedRuntimePath(absolutePath, inputPath);
  }

  private assertNotProtectedRuntimePath(absolutePath: string, inputPath: string): void {
    const resolvedPath = resolve(absolutePath);
    if (!this.protectedRuntimePaths().some((path) => isPathInsideRoot(resolvedPath, path))) return;
    throw new AccessDeniedError(`Protected DevSpace credential/state path cannot be accessed: ${inputPath}`);
  }

  private assertShellAllowed(workspace: Workspace): void {
    if (this.config.dangerouslyAllowShellInCredentialRoots) return;
    const root = resolve(workspace.root);
    const containsProtectedRuntime = this.protectedRuntimePaths().some((path) => isPathInsideRoot(path, root));
    if (!containsProtectedRuntime) return;
    throw new AccessDeniedError(
      "Shell is disabled in workspaces that contain DevSpace credential/state files. Open a narrower workspace instead.",
    );
  }

  private protectedRuntimePaths(): string[] {
    const configDir = dirname(this.config.sshAdminUnlockPath);
    return Array.from(new Set([
      resolve(configDir, "auth.json"),
      resolve(this.config.sshAdminUnlockPath),
      resolve(this.config.stateDir),
    ]));
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const rootStats = await ensureCheckoutWorkspaceRoot(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    return this.createWorkspaceContext({ root, mode: "checkout" });
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomBytes(5).toString("hex")}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
      activatedSkillDirs: new Set(),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
    });
    this.workspaces.set(workspace.id, workspace);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: false,
      includeBootstrapContext: true,
    };
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }

    return assertAllowedPath(root, this.config.allowedRoots);
  }

  private async loadInitialAgentsFiles(root: string): Promise<LoadedAgentsFile[]> {
    const agentDir = resolve(this.config.agentDir);
    const resolvedRoot = (await tryRealpath(root)) ?? root;
    const resolvedAgentDir = (await tryRealpath(agentDir)) ?? agentDir;
    const loadedFiles: LoadedAgentsFile[] = [];

    for (const file of loadProjectContextFiles({ cwd: root, agentDir })) {
      const path = resolve(file.path);
      if (!isInitialAgentsFilePath(path, root, agentDir)) continue;
      const content = await readResolvedContextFile(
        path,
        file.content,
        resolvedRoot,
        resolvedAgentDir,
      );
      if (content === undefined) continue;

      loadedFiles.push({
        path,
        content,
      });
    }

    return loadedFiles;
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const loadedRealPaths = new Set<string>();
    for (const file of loadedFiles) {
      const realPath = await tryRealpath(file.path);
      if (realPath) loadedRealPaths.add(realPath);
    }
    const discovered: AvailableAgentsFile[] = [];

    await walkWorkspace(root, async (path, entry) => {
      if (!entry.isFile()) return;
      if (!CONTEXT_FILE_NAMES.has(entry.name)) return;
      if (loadedPaths.has(path)) return;
      const realPath = await tryRealpath(path);
      if (realPath && loadedRealPaths.has(realPath)) return;

      discovered.push({ path });
    });

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }
}

async function canonicalPath(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }

      const parent = dirname(candidate);
      if (parent === candidate) return path;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function ensureCheckoutWorkspaceRoot(
  path: string,
  ops: DirectoryOps = { stat, mkdir },
): Promise<PathStats> {
  try {
    return await ops.stat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await ops.mkdir(path, { recursive: true });
  return await ops.stat(path);
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

function isInitialAgentsFilePath(path: string, root: string, agentDir: string): boolean {
  if (isPathInsideRoot(path, agentDir)) return true;
  return isPathInsideRoot(path, root) && dirname(path) === root;
}

async function readResolvedContextFile(
  path: string,
  fallbackContent: string,
  root: string,
  agentDir: string,
): Promise<string | undefined> {
  try {
    const resolvedPath = await realpath(path);
    if (!isInitialAgentsFilePath(resolvedPath, root, agentDir)) return undefined;
    return await readFile(resolvedPath, "utf8");
  } catch {
    return fallbackContent;
  }
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
): Promise<void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        await walkWorkspace(path, visit);
      }
      continue;
    }

    await visit(path, entry);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
