import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceTransferResult {
  source: string;
  destination: string;
  files: number;
  directories: number;
  symlinks: number;
  bytes: number;
  removedSource: boolean;
  copyMethod: "ditto" | "fs.cp" | "verified-existing";
  ddevDetected: boolean;
  ddevStarted: boolean;
  ddevOutput?: string;
}

interface TreeStats {
  files: number;
  directories: number;
  symlinks: number;
  bytes: number;
}

export async function transferWorkspace(input: {
  source: string;
  destination: string;
  removeSource: boolean;
  startDdev: boolean;
}): Promise<WorkspaceTransferResult> {
  const sourceStats = await stat(input.source);
  if (!sourceStats.isDirectory()) throw new Error("Workspace source must be a directory.");

  const parentStats = await stat(dirname(input.destination)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Destination parent does not exist: ${dirname(input.destination)}`);
    }
    throw error;
  });
  if (!parentStats.isDirectory()) {
    throw new Error(`Destination parent is not a directory: ${dirname(input.destination)}`);
  }

  const destinationExists = await lstat(input.destination)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
  if (destinationExists) {
    if (!input.removeSource || input.startDdev) {
      throw new Error(
        `Destination already exists: ${input.destination}. To finalize a previously copied workspace, use removeSource=true and startDdev=false.`,
      );
    }
    return finalizeExistingTransfer(input);
  }

  const ddevDetected = await isDdevProject(input.source);
  let copyMethod: "ditto" | "fs.cp" = "fs.cp";
  let sourceRemoved = false;

  try {
    if (platform() === "darwin") {
      await execFileAsync("ditto", ["--rsrc", "--extattr", "--qtn", "--acl", input.source, input.destination], {
        maxBuffer: 1024 * 1024,
      });
      copyMethod = "ditto";
    } else {
      const { cp } = await import("node:fs/promises");
      await cp(input.source, input.destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
    }

    const stats = await compareTrees(input.source, input.destination);
    await verifyFileContents(input.source, input.destination);
    let ddevStarted = false;
    let ddevOutput: string | undefined;
    if (input.startDdev && ddevDetected) {
      ddevOutput = await runDdevStart(input.destination);
      ddevStarted = true;
    }

    if (input.removeSource) {
      await rm(input.source, { recursive: true, force: false });
      sourceRemoved = true;
      await assertMissing(input.source, "Source removal verification failed; source still exists.");
    }

    return {
      source: input.source,
      destination: input.destination,
      ...stats,
      removedSource: input.removeSource,
      copyMethod,
      ddevDetected,
      ddevStarted,
      ddevOutput,
    };
  } catch (error) {
    if (!sourceRemoved) await rm(input.destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function finalizeExistingTransfer(input: {
  source: string;
  destination: string;
  removeSource: boolean;
  startDdev: boolean;
}): Promise<WorkspaceTransferResult> {
  const destinationStats = await stat(input.destination);
  if (!destinationStats.isDirectory()) {
    throw new Error(`Existing destination is not a directory: ${input.destination}`);
  }

  const stats = await compareTrees(input.source, input.destination, false, true);
  await verifyFileContents(input.source, input.destination, true);
  await rm(input.source, { recursive: true, force: false });
  await assertMissing(input.source, "Source removal verification failed; source still exists.");

  return {
    source: input.source,
    destination: input.destination,
    ...stats,
    removedSource: true,
    copyMethod: "verified-existing",
    ddevDetected: await isDdevProject(input.destination),
    ddevStarted: false,
  };
}

async function assertMissing(path: string, message: string): Promise<void> {
  await lstat(path).then(
    () => { throw new Error(message); },
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    },
  );
}

async function isDdevProject(root: string): Promise<boolean> {
  return lstat(join(root, ".ddev", "config.yaml"))
    .then((entry) => entry.isFile())
    .catch(() => false);
}

async function runDdevStart(cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("ddev", ["start"], {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
    });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`DDEV start failed: ${(details.stderr || details.stdout || details.message || String(error)).trim()}`);
  }
}

async function compareTrees(
  source: string,
  destination: string,
  verifyContents = false,
  allowDestinationExtras = false,
): Promise<TreeStats> {
  const sourceEntry = await lstat(source);
  const destinationEntry = await lstat(destination);
  compareEntry(sourceEntry, destinationEntry, ".");

  const stats: TreeStats = { files: 0, directories: 0, symlinks: 0, bytes: 0 };
  await compareDirectory(source, destination, stats, verifyContents, allowDestinationExtras, ".");
  return stats;
}

async function compareDirectory(
  source: string,
  destination: string,
  stats: TreeStats,
  verifyContents: boolean,
  allowDestinationExtras: boolean,
  relativeDirectory: string,
): Promise<void> {
  const [sourceEntries, destinationEntries] = await Promise.all([
    readdir(source, { withFileTypes: true }),
    readdir(destination, { withFileTypes: true }),
  ]);
  const skipGenerated = allowDestinationExtras;
  const sourceNames = sourceEntries
    .map((entry) => entry.name)
    .filter((name) => !skipGenerated || !isGeneratedTransferPath(join(relativeDirectory, name)))
    .sort();
  const destinationNames = destinationEntries
    .map((entry) => entry.name)
    .filter((name) => !skipGenerated || !isGeneratedTransferPath(join(relativeDirectory, name)))
    .sort();
  const destinationNameSet = new Set(destinationNames);

  if (!allowDestinationExtras &&
      (sourceNames.length !== destinationNames.length || sourceNames.some((name, index) => name !== destinationNames[index]))) {
    throw new Error(`Transfer verification failed in ${source}: directory entries differ.`);
  }
  if (allowDestinationExtras && sourceNames.some((name) => !destinationNameSet.has(name))) {
    throw new Error(`Transfer verification failed in ${source}: source directory entries are missing from destination.`);
  }

  for (const name of sourceNames) {
    const sourcePath = join(source, name);
    const destinationPath = join(destination, name);
    const [sourceEntry, destinationEntry] = await Promise.all([lstat(sourcePath), lstat(destinationPath)]);
    compareEntry(sourceEntry, destinationEntry, relative(source, sourcePath));

    if (sourceEntry.isDirectory()) {
      stats.directories += 1;
      await compareDirectory(
        sourcePath,
        destinationPath,
        stats,
        verifyContents,
        allowDestinationExtras,
        join(relativeDirectory, name),
      );
    } else if (sourceEntry.isSymbolicLink()) {
      const [sourceTarget, destinationTarget] = await Promise.all([readlink(sourcePath), readlink(destinationPath)]);
      if (sourceTarget !== destinationTarget) {
        throw new Error(`Transfer verification failed at ${name}: symlink target differs.`);
      }
      stats.symlinks += 1;
    } else if (sourceEntry.isFile()) {
      stats.files += 1;
      stats.bytes += sourceEntry.size;
      if (verifyContents) {
        const [sourceHash, destinationHash] = await Promise.all([
          hashFile(sourcePath),
          hashFile(destinationPath),
        ]);
        if (sourceHash !== destinationHash) {
          throw new Error(`Transfer verification failed at ${name}: file contents differ.`);
        }
      }
    }
  }
}

async function verifyFileContents(source: string, destination: string, allowDestinationExtras = false): Promise<void> {
  try {
    const { stdout } = await execFileAsync("rsync", [
      "-acn",
      ...(allowDestinationExtras ? [] : ["--delete"]),
      ...(allowDestinationExtras
        ? [
            "--exclude=.DS_Store",
            "--exclude=.git/***",
            "--exclude=.ddev/.ddev-docker-compose-base.yaml",
            "--exclude=.ddev/.ddev-docker-compose-full.yaml",
            "--exclude=.ddev/traefik/certs/***",
            "--exclude=.ddev/traefik/config/***",
          ]
        : []),
      "--exclude=._*",
      "--out-format=__DEVSPACE_CHANGE__%i %n%L",
      `${source}/`,
      `${destination}/`,
    ], { maxBuffer: 4 * 1024 * 1024 });
    const changes = stdout.split(/\r?\n/).filter((line) => line.startsWith("__DEVSPACE_CHANGE__"));
    if (changes.length > 0) {
      throw new Error(`Transfer verification failed: rsync reported differences.\n${changes.slice(0, 20).join("\n")}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await compareTrees(source, destination, true);
      return;
    }
    if (error instanceof Error && error.message.startsWith("Transfer verification failed:")) throw error;
    const details = error as { stderr?: string; message?: string };
    throw new Error(`Transfer verification failed: ${(details.stderr || details.message || String(error)).trim()}`);
  }
}

function isGeneratedTransferPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized === ".DS_Store"
    || normalized.endsWith("/.DS_Store")
    || normalized === ".git"
    || normalized.startsWith(".git/")
    || normalized === ".ddev/.ddev-docker-compose-base.yaml"
    || normalized === ".ddev/.ddev-docker-compose-full.yaml"
    || normalized.startsWith(".ddev/traefik/certs/")
    || normalized.startsWith(".ddev/traefik/config/");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function compareEntry(
  source: Awaited<ReturnType<typeof lstat>>,
  destination: Awaited<ReturnType<typeof lstat>>,
  path: string,
): void {
  const sameKind = source.isDirectory() === destination.isDirectory()
    && source.isFile() === destination.isFile()
    && source.isSymbolicLink() === destination.isSymbolicLink();
  if (!sameKind || ((Number(source.mode) & 0o7777) !== (Number(destination.mode) & 0o7777))) {
    throw new Error(`Transfer verification failed at ${path}: entry type or permissions differ.`);
  }
  if (source.isFile() && source.size !== destination.size) {
    throw new Error(`Transfer verification failed at ${path}: file size differs.`);
  }
}
