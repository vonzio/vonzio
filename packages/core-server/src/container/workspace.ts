import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceConfig } from "@vonzio/shared";

const execFileAsync = promisify(execFile);

/**
 * git_url runs through `git clone` on the HOST (before any container exists),
 * so the transport must be locked down. `git` honours pseudo-transports like
 * `ext::sh -c '…'` (arbitrary command execution) and `file://` (host file
 * read) regardless of execFile/no-shell — the danger is git itself, not the
 * shell. Allow only real http(s) remotes; everything else is refused.
 */
function assertSafeGitUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      "git_url must be an http(s) URL (ssh, file, ext and other git transports are not allowed)",
    );
  }
}

/**
 * git_ref becomes the value of `--branch`. Reject anything that could be
 * parsed as an option (leading '-') or smuggle extra args (whitespace).
 */
function assertSafeGitRef(ref: string): void {
  if (ref.startsWith("-") || /\s/.test(ref)) {
    throw new Error("git_ref contains invalid characters");
  }
}

export class WorkspaceProvisioner {
  async provision(config: WorkspaceConfig): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), "vonzio-ws-"));

    if (config.type === "git") {
      await this.cloneRepo(tempDir, config);
    } else if (config.type === "files") {
      await this.writeFiles(tempDir, config.files ?? []);
    }

    return tempDir;
  }

  async cleanup(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  private async cloneRepo(dir: string, config: WorkspaceConfig): Promise<void> {
    let url = config.git_url!;
    assertSafeGitUrl(url);
    if (config.git_ref) assertSafeGitRef(config.git_ref);
    if (config.git_pat) {
      // Inject PAT into the URL for authentication
      url = url.replace("https://", `https://${config.git_pat}@`);
    }

    const args = ["clone", "--depth", "1"];
    if (config.git_ref) {
      args.push("--branch", config.git_ref);
    }
    // `--` stops option parsing so a crafted url/dir can't be read as a flag.
    args.push("--", url, dir);

    await execFileAsync("git", args, {
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  private async writeFiles(
    dir: string,
    files: { path: string; content: string }[],
  ): Promise<void> {
    // Containment: writeFiles runs on the HOST as the core-server process,
    // and file.path comes straight from the public task-submission endpoint.
    // Resolve every path and confirm it stays inside the workspace tmpdir, or
    // a crafted `../../…` escapes it and writes arbitrary host files.
    const root = resolve(dir);
    await Promise.all(
      files.map(async (file) => {
        const fullPath = resolve(root, file.path);
        const rel = relative(root, fullPath);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error(`Refusing to write file outside the workspace: ${file.path}`);
        }
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, file.content, "utf8");
      }),
    );
  }
}
