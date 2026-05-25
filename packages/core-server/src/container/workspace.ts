import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceConfig } from "@vonzio/shared";

const execFileAsync = promisify(execFile);

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
    if (config.git_pat) {
      // Inject PAT into the URL for authentication
      url = url.replace("https://", `https://${config.git_pat}@`);
    }

    const args = ["clone", "--depth", "1"];
    if (config.git_ref) {
      args.push("--branch", config.git_ref);
    }
    args.push(url, dir);

    await execFileAsync("git", args, {
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  private async writeFiles(
    dir: string,
    files: { path: string; content: string }[],
  ): Promise<void> {
    await Promise.all(
      files.map(async (file) => {
        const fullPath = join(dir, file.path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, file.content, "utf8");
      }),
    );
  }
}
