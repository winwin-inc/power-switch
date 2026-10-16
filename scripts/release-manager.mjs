import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkVersion,
  expectedAssets,
  packageVersion,
  sha256,
  updaterArtifactExtension,
  versionFromTag,
} from "./release.mjs";

export const repository = "winwin-inc/power-switch";
export const versionFiles = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const timeoutDefault = 120 * 60 * 1000;

/** 比较 SemVer，构建元数据不改变优先级，数字标识符使用整数比较。 */
export function compareVersions(left, right) {
  const parse = (value) => versionFromTag(value).split("+")[0].split(/-(.*)/s);
  const [a, ap] = parse(left);
  const [b, bp] = parse(right);
  const compare = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  for (let i = 0; i < 3; i += 1) {
    const result = compare(BigInt(a.split(".")[i]), BigInt(b.split(".")[i]));
    if (result) return result;
  }
  if (ap === undefined || bp === undefined)
    return compare(ap === undefined, bp === undefined);
  const aa = ap.split("."),
    bb = bp.split(".");
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    if (aa[i] === undefined || bb[i] === undefined)
      return compare(aa.length, bb.length);
    const numericA = /^\d+$/.test(aa[i]),
      numericB = /^\d+$/.test(bb[i]);
    const result =
      numericA && numericB
        ? compare(BigInt(aa[i]), BigInt(bb[i]))
        : numericA !== numericB
          ? compare(!numericA, !numericB)
          : compare(aa[i], bb[i]);
    if (result) return result;
  }
  return 0;
}

/** 独立递增 MSI 前三段，第四段固定为零；溢出时停止而不猜测新版本。 */
export function nextMsiVersion(current) {
  if (!/^\d+\.\d+\.\d+\.0$/.test(current ?? ""))
    throw new Error("MSI version must be major.minor.patch.0");
  const [major, minor, patch] = current.split(".").map(Number);
  if (major > 255 || minor > 255 || patch >= 65535)
    throw new Error(
      "MSI ProductVersion exceeds 255.255.65535; choose a new valid MSI series manually",
    );
  return `${major}.${minor}.${patch + 1}.0`;
}

/** 精确替换本项目 TOML 表中的版本，不修改其他依赖或重新生成锁文件。 */
export function replacePackageVersion(contents, version, lock = false) {
  packageVersion(contents, lock);
  const heading = lock ? "[[package]]" : "[package]";
  return contents
    .split(/(?=^\[)/m)
    .map((section) =>
      section.split(/\r?\n/, 1)[0].trim() === heading &&
      /^name\s*=\s*"power-switch"\s*(?:#.*)?$/m.test(section)
        ? section.replace(/^(version\s*=\s*")[^"\r\n]+(")/m, `$1${version}$2`)
        : section,
    )
    .join("");
}

/** 列出唯一允许自动暂存的版本文件和本版本发布说明。 */
export function releaseFiles(tag) {
  versionFromTag(tag);
  return [...versionFiles, `docs/releases/${tag}.md`];
}

/** 解析校验清单，拒绝重复、未知文件、路径穿越以及不完整集合。 */
export function parseChecksums(contents, tag) {
  const sums = new Map();
  for (const line of contents.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9.+-]+)$/.exec(line);
    if (!match || sums.has(match[2]))
      throw new Error("Invalid or duplicate SHA256SUMS entry");
    sums.set(match[2], match[1]);
  }
  if (
    JSON.stringify([...sums.keys()].sort()) !==
    JSON.stringify(expectedAssets(tag))
  )
    throw new Error("Incomplete or unexpected SHA256SUMS entries");
  return sums;
}

/** 校验公开资产集合、服务端摘要和六种架构的更新 URL 与签名字段。 */
export function validatePublishedRelease(
  release,
  assets,
  contents,
  manifest,
  tag,
  repo = repository,
) {
  if (release.tag_name !== tag || release.draft)
    throw new Error("Expected a published release for this tag");
  const names = [...expectedAssets(tag), "SHA256SUMS", "latest.json"].sort();
  if (
    JSON.stringify(assets.map((a) => a.name).sort()) !== JSON.stringify(names)
  )
    throw new Error("Release assets are missing, duplicate or unexpected");
  const sums = parseChecksums(contents, tag);
  for (const asset of assets) {
    if (
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")
    )
      throw new Error(`Invalid asset metadata: ${asset.name}`);
    if (
      sums.has(asset.name) &&
      asset.digest !== `sha256:${sums.get(asset.name)}`
    )
      throw new Error(`Checksum mismatch: ${asset.name}`);
  }
  const mapping = {
    "darwin-aarch64": "macos-universal",
    "darwin-x86_64": "macos-universal",
    "windows-x86_64": "windows-x64",
    "windows-aarch64": "windows-arm64",
    "linux-x86_64": "linux-x64",
    "linux-aarch64": "linux-arm64",
  };
  if (
    manifest.version !== tag ||
    !Number.isFinite(Date.parse(manifest.pub_date)) ||
    JSON.stringify(Object.keys(manifest.platforms ?? {}).sort()) !==
      JSON.stringify(Object.keys(mapping).sort())
  )
    throw new Error("Invalid updater version, date or architecture set");
  for (const [architecture, platform] of Object.entries(mapping)) {
    const entry = manifest.platforms[architecture];
    const expected = `https://github.com/${repo}/releases/download/${tag}/power-switch-${tag}-${platform}.${updaterArtifactExtension(platform)}`;
    // minisign 的外层 Base64 内容至少包含签名数据，禁止空值及明显损坏字段。
    if (
      entry?.url !== expected ||
      typeof entry.signature !== "string" ||
      entry.signature.length < 40 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.signature)
    )
      throw new Error(`Invalid updater URL or signature: ${architecture}`);
  }
  return {
    assetCount: names.length,
    checksumCount: sums.size,
    architectures: Object.keys(mapping),
  };
}

/** 解析严格的命令行参数；等待上限适用于每一个 CI/发布阶段。 */
export function parseArguments(args) {
  const result = {
    command: args[0],
    dryRun: false,
    download: false,
    timeoutMs: timeoutDefault,
  };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "") continue;
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--download") result.download = true;
    else if (
      arg === "--timeout-minutes" ||
      arg.startsWith("--timeout-minutes=")
    ) {
      const value = arg.includes("=") ? arg.split("=")[1] : args[++i];
      if (
        !/^\d+$/.test(value ?? "") ||
        Number(value) < 1 ||
        Number(value) > 240
      )
        throw new Error("--timeout-minutes must be 1..240");
      result.timeoutMs = Number(value) * 60000;
    } else if (!arg.startsWith("-") && !result.tag) result.tag = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    ![
      "doctor",
      "prepare",
      "pr",
      "merge",
      "publish",
      "status",
      "verify",
      "promote",
    ].includes(result.command)
  )
    throw new Error(
      "Usage: release-manager.mjs doctor|prepare|pr|merge|publish|status|verify|promote [v<version>] [--dry-run] [--download] [--timeout-minutes N]",
    );
  if (result.command !== "doctor") versionFromTag(result.tag);
  if (
    result.dryRun &&
    !["prepare", "pr", "merge", "publish", "promote"].includes(result.command)
  )
    throw new Error(
      "--dry-run is only available for prepare/pr/merge/publish/promote",
    );
  if (result.download && result.command !== "verify")
    throw new Error("--download is only available for verify");
  return result;
}

/** 封装 Git/GitHub 操作，允许测试注入模拟执行器，始终不用 shell 拼接参数。 */
export class ReleaseManager {
  /** 初始化仓库、执行器、轮询时钟和日志；GitHub 凭据由 gh 自行管理。 */
  constructor({
    root = projectRoot,
    run = execFileSync,
    repo = repository,
    log = console.log,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    ...options
  } = {}) {
    Object.assign(this, {
      root: resolve(root),
      run,
      repo,
      log,
      wait,
      now,
      dryRun: false,
      timeoutMs: timeoutDefault,
      ...options,
    });
  }

  /** 执行有超时的原生命令；不把凭据加入参数、文件或日志。 */
  execute(program, args, options = {}) {
    return this.run(program, args, {
      cwd: this.root,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    }).trim();
  }

  /** 执行 Git 命令，统一使用当前仓库路径。 */
  git(...args) {
    return this.execute("git", args);
  }

  /** 执行 GitHub CLI，所有请求明确限定目标仓库。 */
  gh(...args) {
    return this.execute("gh", args);
  }

  /** 请求 GitHub JSON；仅明确的 HTTP 404 可以视为不存在。 */
  api(path, optional = false) {
    try {
      return JSON.parse(this.gh("api", path));
    } catch (error) {
      if (optional && /HTTP 404/.test(String(error.stderr ?? error.message)))
        return null;
      throw error;
    }
  }

  /** 在 dry-run 中只显示变更命令，不执行本地或远端写操作。 */
  mutate(program, args) {
    this.log(
      `${this.dryRun ? "[dry-run] " : ""}${program} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
    );
    if (!this.dryRun) return this.execute(program, args);
  }

  /** 验证 origin 指向本仓库，避免把发布分支或标签推送到其他仓库。 */
  assertOrigin() {
    const remote = this.git("remote", "get-url", "origin");
    if (
      ![
        `git@github.com:${this.repo}.git`,
        `git@github.com:${this.repo}`,
        `https://github.com/${this.repo}.git`,
        `https://github.com/${this.repo}`,
      ].includes(remote)
    )
      throw new Error(`origin must point to github.com/${this.repo}`);
  }

  /** 分别检查暂存和未暂存路径，拒绝发布白名单以外的任何改动。 */
  assertChanges(allowed = []) {
    const tracked = this.git("diff", "HEAD", "--name-only", "-z");
    const untracked = this.git(
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    );
    const staged = this.git("diff", "--cached", "--name-only", "-z");
    const names = new Set(
      [tracked, untracked, staged].flatMap((s) =>
        s.split("\0").filter(Boolean),
      ),
    );
    for (const name of names) {
      if (
        name
          .split("/")
          .some(
            (p) =>
              [".env", ".venv", "venv"].includes(p) || p.startsWith(".env."),
          ) ||
        !allowed.includes(name)
      )
        throw new Error(
          `Unexpected working tree/staged change: ${name}. Commit it separately before releasing.`,
        );
    }
    return [...names];
  }

  /** 读取已提交的本版本说明，拒绝 TODO 或空白更新条目。 */
  async notes(tag) {
    const text = await readFile(
      join(this.root, releaseFiles(tag).at(-1)),
      "utf8",
    );
    const changes = /### 本次更新\s*\n([\s\S]*?)(?=\n### |$)/.exec(text)?.[1];
    if (
      text.split(/\r?\n/, 1)[0].trim() !== `## power-switch ${tag}` ||
      !changes ||
      !/^\s*-\s+\S/m.test(changes) ||
      /TODO|待填写|填写本次变更/i.test(changes)
    )
      throw new Error(
        `Complete docs/releases/${tag}.md before creating the PR`,
      );
    return text;
  }

  /** 准备分支和四份版本清单；相同已准备分支的重跑不会再次递增 MSI。 */
  async prepare(tag) {
    const version = versionFromTag(tag),
      branch = `codex/release-${tag}`;
    this.assertOrigin();
    const currentBranch = this.git("branch", "--show-current");
    const current = JSON.parse(
      await readFile(join(this.root, "package.json"), "utf8"),
    ).version;
    if (current === version && currentBranch === branch) {
      this.assertChanges(releaseFiles(tag));
      await checkVersion(this.root, tag);
      await readFile(join(this.root, releaseFiles(tag).at(-1)), "utf8");
      this.log(
        `${branch} is already prepared; edit its release notes, then run just check.`,
      );
      return;
    }
    this.assertChanges();
    if (compareVersions(tag, `v${current}`) <= 0)
      throw new Error(
        "Target version must be greater than the current version",
      );
    await checkVersion(this.root, `v${current}`);
    this.git("merge-base", "--is-ancestor", "origin/master", "HEAD");
    const refs = this.git(
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${branch}`,
      `refs/tags/${tag}`,
    );
    if (refs)
      throw new Error(
        `Branch or tag already exists; inspect it instead of overwriting: ${refs}`,
      );
    const files = new Map();
    for (const file of versionFiles) {
      const text = await readFile(join(this.root, file), "utf8");
      if (file.endsWith(".json")) {
        const data = JSON.parse(text);
        data.version = version;
        if (file.endsWith("tauri.conf.json"))
          data.bundle.windows.wix.version = nextMsiVersion(
            data.bundle.windows.wix.version,
          );
        // 仅替换版本字段，保留仓库原有 JSON 排版。
        let updated = text.replace(
          /("version"\s*:\s*")[^"]+"/,
          `$1${version}"`,
        );
        if (file.endsWith("tauri.conf.json"))
          updated = updated.replace(
            /("wix"\s*:\s*\{\s*"version"\s*:\s*")[^"]+"/,
            `$1${data.bundle.windows.wix.version}"`,
          );
        files.set(file, updated);
      } else
        files.set(
          file,
          replacePackageVersion(text, version, file.endsWith(".lock")),
        );
    }
    const template = await readFile(
      join(this.root, ".github/RELEASE_TEMPLATE.md"),
      "utf8",
    );
    if (!/### 本次更新\s*\n[\s\S]*?\n### 下载选择/.test(template))
      throw new Error(
        "Release template is missing its changes/download sections",
      );
    files.set(
      releaseFiles(tag).at(-1),
      template
        .replace(/^## power-switch.*$/m, `## power-switch ${tag}`)
        .replace(
          /### 本次更新\s*\n[\s\S]*?\n### 下载选择/,
          "### 本次更新\n\n- TODO: 填写本次变更。\n\n### 下载选择",
        ),
    );
    this.mutate("git", ["switch", "-c", branch]);
    for (const [file, text] of files) {
      this.log(`${this.dryRun ? "[dry-run] " : ""}write ${file}`);
      if (!this.dryRun) {
        await mkdir(join(this.root, "docs/releases"), { recursive: true });
        await writeFile(join(this.root, file), text);
      }
    }
  }

  /** 查询本仓库对应发布分支的唯一活动或已合并 PR。 */
  findPr(tag) {
    const prs = JSON.parse(
      this.gh(
        "pr",
        "list",
        "--repo",
        this.repo,
        "--head",
        `codex/release-${tag}`,
        "--base",
        "master",
        "--state",
        "all",
        "--limit",
        "100",
        "--json",
        "number,url,state,headRefOid,mergeCommit,isCrossRepository",
      ),
    );
    const matches = prs.filter(
      (pr) => !pr.isCrossRepository && ["OPEN", "MERGED"].includes(pr.state),
    );
    if (matches.length > 1)
      throw new Error(
        "Multiple release PRs found; resolve the ambiguity manually",
      );
    return matches[0] ?? null;
  }

  /** 仅提交版本白名单，复用同提交 PR；不自动包含其他改动。 */
  async pr(tag) {
    this.assertOrigin();
    if (this.git("branch", "--show-current") !== `codex/release-${tag}`)
      throw new Error(`Check out codex/release-${tag} first`);
    const changes = this.assertChanges(releaseFiles(tag));
    await checkVersion(this.root, tag);
    await this.notes(tag);
    const existing = this.findPr(tag);
    const head = this.git("rev-parse", "HEAD");
    if (existing && (changes.length || existing.headRefOid !== head))
      throw new Error(
        "Release PR belongs to another commit or has new local changes; review them before updating",
      );
    if (existing) {
      this.log(existing.url);
      return existing;
    }
    if (changes.length) {
      this.mutate("git", ["add", "--", ...releaseFiles(tag)]);
      if (!this.dryRun) this.git("diff", "--cached", "--check");
      this.mutate("git", ["commit", "-m", `chore(release): prepare ${tag}`]);
    }
    const branch = `codex/release-${tag}`;
    const remote = this.api(`repos/${this.repo}/git/ref/heads/${branch}`, true);
    if (remote && remote.object.sha !== this.git("rev-parse", "HEAD"))
      throw new Error(
        "Remote release branch points to another commit; refusing to overwrite it",
      );
    this.mutate("git", ["push", "-u", "origin", branch]);
    const result = this.mutate("gh", [
      "pr",
      "create",
      "--repo",
      this.repo,
      "--base",
      "master",
      "--head",
      branch,
      "--title",
      `chore(release): prepare ${tag}`,
      "--body-file",
      releaseFiles(tag).at(-1),
    ]);
    if (result) this.log(result);
    return result;
  }

  /** 获取工作流运行并严格绑定仓库、工作流、完整 SHA、分支及事件。 */
  runs(workflow, sha, branch, events) {
    if (!/^[a-f0-9]{40}$/.test(sha))
      throw new Error("Expected a full commit SHA");
    const data = this.api(
      `repos/${this.repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&branch=${encodeURIComponent(branch)}&per_page=100`,
    );
    return data.workflow_runs
      .filter(
        (run) =>
          run.repository?.full_name === this.repo &&
          run.head_sha === sha &&
          run.head_branch === branch &&
          events.includes(run.event) &&
          run.path?.split("@")[0] === `.github/workflows/${workflow}`,
      )
      .sort((a, b) => b.id - a.id);
  }

  /** 有限等待匹配工作流；失败时输出精确日志与重跑命令，不自动重建。 */
  async waitRun(workflow, sha, branch, events) {
    const deadline = this.now() + this.timeoutMs;
    const discoverDeadline = this.now() + Math.min(this.timeoutMs, 120000);
    let previous;
    while (this.now() < deadline) {
      const run = this.runs(workflow, sha, branch, events)[0];
      const state = run
        ? `${run.id}/${run.run_attempt}/${run.status}/${run.conclusion}`
        : "awaiting workflow creation";
      if (state !== previous) {
        this.log(`${workflow}: ${state}${run ? ` ${run.html_url}` : ""}`);
        previous = state;
      }
      if (run?.status === "completed") {
        if (run.conclusion !== "success")
          throw new Error(
            `${workflow}: ${run.conclusion}. Logs: ${run.html_url}\nRecover: gh run rerun ${run.id} --failed --repo ${this.repo}`,
          );
        return run;
      }
      if (!run && this.now() >= discoverDeadline)
        throw new Error(
          `Workflow not found for ${branch}@${sha}. Check Actions permissions/trigger; resume with release-status and the same command.`,
        );
      await this.wait(15000);
    }
    throw new Error(
      `Timed out waiting for ${workflow} at ${branch}@${sha}; use just release-status ${branch.startsWith("v") ? branch : branch.replace("codex/release-", "")} and resume the same command.`,
    );
  }

  /** 等待发布 PR 的 CI，通过完整 SHA 条件合并，避免合并检查后的新提交。 */
  async merge(tag) {
    const pr = this.findPr(tag);
    if (!pr) throw new Error("Create the release PR first");
    if (pr.state === "MERGED") {
      this.log(`Already merged: ${pr.url}`);
      return pr;
    }
    if (this.dryRun) {
      this.log(`[dry-run] wait for CI on ${pr.headRefOid}`);
    } else {
      await this.waitRun("ci.yml", pr.headRefOid, `codex/release-${tag}`, [
        "pull_request",
      ]);
      const current = this.findPr(tag);
      if (!current || current.headRefOid !== pr.headRefOid)
        throw new Error("PR head changed after CI; run release-merge again");
      const checks = JSON.parse(
        this.gh(
          "pr",
          "view",
          String(pr.number),
          "--repo",
          this.repo,
          "--json",
          "statusCheckRollup",
        ),
      ).statusCheckRollup;
      if (
        !checks?.length ||
        checks.some((c) =>
          c.__typename === "StatusContext"
            ? c.state !== "SUCCESS"
            : c.status !== "COMPLETED" ||
              !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion),
        )
      )
        throw new Error(`PR has pending/failed checks: ${pr.url}`);
    }
    this.mutate("gh", [
      "pr",
      "merge",
      String(pr.number),
      "--repo",
      this.repo,
      "--merge",
      "--match-head-commit",
      pr.headRefOid,
    ]);
    return pr;
  }

  /** 获取远程标签指向的提交，解析 annotated tag，不信任 target_commitish。 */
  remoteTag(tag) {
    let ref = this.api(
      `repos/${this.repo}/git/ref/tags/${encodeURIComponent(tag)}`,
      true,
    );
    if (!ref) return null;
    let object = ref.object;
    for (let depth = 0; object.type === "tag" && depth < 5; depth += 1)
      object = this.api(`repos/${this.repo}/git/tags/${object.sha}`).object;
    if (object.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha))
      throw new Error("Tag does not resolve to a commit");
    return object.sha;
  }

  /** 核对该发布 PR 的合并提交，使用同一标签/运行续跑而不重复触发构建。 */
  async publish(tag) {
    this.assertOrigin();
    this.assertChanges();
    const pr = this.findPr(tag);
    if (pr?.state !== "MERGED" || !pr.mergeCommit?.oid)
      throw new Error("Merge the release PR before publishing");
    const sha = pr.mergeCommit.oid;
    const remote = this.remoteTag(tag);
    if (remote && remote !== sha)
      throw new Error(
        "Existing release tag belongs to another commit; never move it",
      );
    if (this.dryRun) {
      this.log(
        `[dry-run] validate master ancestry, versions and master CI for ${sha}`,
      );
      if (!remote) {
        this.mutate("git", [
          "tag",
          "-a",
          tag,
          sha,
          "-m",
          `power-switch ${tag}`,
        ]);
        this.mutate("git", ["push", "origin", `refs/tags/${tag}`]);
      }
      this.log(
        `[dry-run] wait for Release ${tag}@${sha}; keep it as a prerelease`,
      );
      return;
    }
    this.mutate("git", ["fetch", "origin", "master"]);
    this.git("merge-base", "--is-ancestor", sha, "origin/master");
    for (const file of versionFiles) {
      const text = this.git("show", `${sha}:${file}`);
      const version = file.endsWith(".json")
        ? JSON.parse(text).version
        : packageVersion(text, file.endsWith(".lock"));
      if (version !== versionFromTag(tag))
        throw new Error(`Merged commit has a different version in ${file}`);
    }
    await this.waitRun("ci.yml", sha, "master", ["push"]);
    if (!remote) {
      const local = this.git(
        "for-each-ref",
        "--format=%(refname)",
        `refs/tags/${tag}`,
      );
      if (local && this.git("rev-parse", `${tag}^{commit}`) !== sha)
        throw new Error(
          "Local tag points to another commit; inspect it manually",
        );
      if (!local)
        this.mutate("git", [
          "tag",
          "-a",
          tag,
          sha,
          "-m",
          `power-switch ${tag}`,
        ]);
      this.mutate("git", ["push", "origin", `refs/tags/${tag}`]);
      if (this.remoteTag(tag) !== sha)
        throw new Error("Remote tag did not match the expected merge commit");
    }
    const run = await this.waitRun("release.yml", sha, tag, [
      "push",
      "workflow_dispatch",
    ]);
    const release = this.api(`repos/${this.repo}/releases/tags/${tag}`);
    if (release.draft || release.tag_name !== tag)
      throw new Error("Release workflow completed without a published release");
    this.log(
      `Release workflow succeeded: ${run.html_url}\n${release.html_url}\nNext: just release-verify ${tag}`,
    );
  }

  /** 显示远程状态，不改变分支、标签、工作流或 Release。 */
  async status(tag) {
    const pr = this.findPr(tag),
      sha = this.remoteTag(tag);
    const release = this.api(`repos/${this.repo}/releases/tags/${tag}`, true);
    const source = sha ?? pr?.mergeCommit?.oid ?? pr?.headRefOid;
    const ci = source
      ? this.runs(
          "ci.yml",
          source,
          pr?.state === "OPEN" && !sha ? `codex/release-${tag}` : "master",
          pr?.state === "OPEN" && !sha ? ["pull_request"] : ["push"],
        )[0]
      : null;
    const run = sha
      ? this.runs("release.yml", sha, tag, ["push", "workflow_dispatch"])[0]
      : null;
    const jobs = run
      ? this.api(`repos/${this.repo}/actions/runs/${run.id}/jobs?per_page=100`)
          .jobs
      : [];
    // 状态输出只保留运行摘要，避免重复输出完整的 GitHub 仓库元数据。
    const summary = (value) =>
      value
        ? {
            id: value.id,
            sha: value.head_sha,
            status: value.status,
            conclusion: value.conclusion,
            url: value.html_url,
          }
        : null;
    const result = {
      tag,
      sha,
      pr,
      ci: summary(ci),
      release: release
        ? {
            url: release.html_url,
            draft: release.draft,
            prerelease: release.prerelease,
          }
        : null,
      workflow: summary(run),
      jobs: jobs.map((job) => ({
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        url: job.html_url,
      })),
    };
    this.log(JSON.stringify(result, null, 2));
    return result;
  }

  /** 下载并校验元文件，默认比对 GitHub 摘要；--download 额外校验全部包字节。 */
  async verify(tag, download = false) {
    const sha = this.remoteTag(tag);
    if (!sha) throw new Error("Release tag does not exist");
    const run = this.runs("release.yml", sha, tag, [
      "push",
      "workflow_dispatch",
    ]).find(
      (candidate) =>
        candidate.status === "completed" && candidate.conclusion === "success",
    );
    if (!run || run.status !== "completed" || run.conclusion !== "success")
      throw new Error(
        "No successful Release workflow for this exact tag and commit",
      );
    const release = this.api(`repos/${this.repo}/releases/tags/${tag}`);
    const assets = this.api(
      `repos/${this.repo}/releases/${release.id}/assets?per_page=100`,
    );
    const base = join(this.root, "artifacts/releases", tag);
    await mkdir(base, { recursive: true });
    if ((await lstat(base)).isSymbolicLink())
      throw new Error("Release output directory cannot be a symlink");
    const directory = await mkdtemp(join(base, "verify-"));
    const names = download
      ? [...expectedAssets(tag), "SHA256SUMS", "latest.json"]
      : ["SHA256SUMS", "latest.json"];
    const args = [
      "release",
      "download",
      tag,
      "--repo",
      this.repo,
      "--dir",
      directory,
    ];
    for (const name of names) args.push("--pattern", name);
    this.execute("gh", args, { timeout: 600000 });
    for (const name of names) {
      const asset = assets.find((a) => a.name === name);
      const file = join(directory, name),
        stat = await lstat(file);
      if (
        !asset ||
        !stat.isFile() ||
        stat.size !== asset.size ||
        asset.digest !== `sha256:${await sha256(file)}`
      )
        throw new Error(`Downloaded checksum/size mismatch: ${name}`);
    }
    const result = validatePublishedRelease(
      release,
      assets,
      await readFile(join(directory, "SHA256SUMS"), "utf8"),
      JSON.parse(await readFile(join(directory, "latest.json"), "utf8")),
      tag,
      this.repo,
    );
    // 验证末尾再读一次标签和资产，防止校验期间远端文件被替换。
    const latestAssets = this.api(
      `repos/${this.repo}/releases/${release.id}/assets?per_page=100`,
    );
    const identity = (list) =>
      list.map((a) => `${a.id}:${a.name}:${a.size}:${a.digest}`).sort();
    if (
      this.remoteTag(tag) !== sha ||
      JSON.stringify(identity(assets)) !==
        JSON.stringify(identity(latestAssets))
    )
      throw new Error("Release assets or tag changed during verification");
    const report = {
      tag,
      sha,
      releaseId: release.id,
      releaseUrl: release.html_url,
      workflowUrl: run.html_url,
      verifiedAt: new Date(this.now()).toISOString(),
      mode: download
        ? "downloaded-all-assets"
        : "github-digests-and-downloaded-manifests",
      downloadDirectory: directory,
      manualInstallationAcceptance: "not-performed",
      assets: identity(assets),
      ...result,
    };
    const reportPath = join(directory, "verification.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    this.log(
      `Verified ${result.assetCount} assets / ${result.checksumCount} checksums / ${result.architectures.length} updater architectures.\nReport: ${reportPath}`,
    );
    return report;
  }

  /** 显式提升稳定版本；拒绝 RC、降级 Latest 或校验后发生的资产变化。 */
  async promote(tag) {
    if (versionFromTag(tag).split("+")[0].includes("-"))
      throw new Error("Prerelease/RC tags cannot be promoted to Latest");
    const latest = this.api(`repos/${this.repo}/releases/latest`, true);
    if (latest && compareVersions(tag, latest.tag_name) < 0)
      throw new Error("Refusing to downgrade Latest to an older version");
    if (this.dryRun) {
      this.log(`[dry-run] reverify all published assets for ${tag}`);
      this.mutate("gh", [
        "release",
        "edit",
        tag,
        "--repo",
        this.repo,
        "--prerelease=false",
        "--latest",
      ]);
      return;
    }
    const report = await this.verify(tag);
    // 下载核验可能耗时较长，写入 Latest 前再检查一次版本，避免并发发布造成降级。
    const currentLatest = this.api(`repos/${this.repo}/releases/latest`, true);
    if (currentLatest && compareVersions(tag, currentLatest.tag_name) < 0)
      throw new Error(
        "Latest advanced during verification; refusing to downgrade it",
      );
    this.mutate("gh", [
      "release",
      "edit",
      tag,
      "--repo",
      this.repo,
      "--prerelease=false",
      "--latest",
    ]);
    const result = this.api(`repos/${this.repo}/releases/latest`);
    if (
      result.tag_name !== tag ||
      result.draft ||
      result.prerelease ||
      result.id !== report.releaseId
    )
      throw new Error(
        "Latest readback did not match the promoted stable release",
      );
    this.log(`Latest stable release: ${result.html_url}`);
  }

  /** 汇总工具、依赖、工作区和权限诊断，不自动安装依赖或更改配置。 */
  async doctor() {
    const checks = [];
    const check = (name, action, fix) => {
      try {
        const detail = action();
        checks.push({ name, ok: true, detail });
      } catch {
        checks.push({ name, ok: false, fix });
      }
    };
    check(
      "Node.js 22",
      () => {
        const v = this.execute("node", ["--version"]);
        if (!/^v22\./.test(v)) throw new Error();
        return v;
      },
      "Use Node.js 22, matching GitHub Actions.",
    );
    const manifest = JSON.parse(
      await readFile(join(this.root, "package.json"), "utf8"),
    );
    check(
      manifest.packageManager,
      () => {
        const v = this.execute("pnpm", ["--version"]);
        if (v !== manifest.packageManager.split("@")[1]) throw new Error();
        return v;
      },
      `Activate ${manifest.packageManager}; check registry connectivity if a pnpm wrapper cannot resolve it.`,
    );
    for (const tool of ["git", "gh", "cargo", "rustc", "just"])
      check(
        tool,
        () => this.execute(tool, ["--version"]),
        `Install ${tool}; Rust CI uses 1.92.0 (rustfmt and clippy required).`,
      );
    check(
      "Rust >= 1.92.0",
      () => {
        const version = /rustc (\d+\.\d+\.\d+)/.exec(
          this.execute("rustc", ["--version"]),
        )?.[1];
        if (!version || compareVersions(`v${version}`, "v1.92.0") < 0)
          throw new Error();
        return version;
      },
      "Install Rust >= 1.92.0; CI is pinned to 1.92.0.",
    );
    for (const args of [
      ["fmt", "--version"],
      ["clippy", "--version"],
    ])
      check(
        `cargo ${args[0]}`,
        () => this.execute("cargo", args),
        "Install rustfmt and clippy with your Rust toolchain.",
      );
    check(
      "origin",
      () => this.assertOrigin(),
      `Set origin to github.com/${this.repo}.`,
    );
    check(
      "working tree",
      () => this.assertChanges(),
      "Commit local changes separately; never stage .env/.venv/venv.",
    );
    check(
      "GitHub authentication",
      () => {
        this.gh("auth", "status", "--hostname", "github.com");
        return "authenticated";
      },
      "Run gh auth login --hostname github.com --git-protocol ssh --web.",
    );
    check(
      "GitHub repository push permission",
      () => {
        if (!this.api(`repos/${this.repo}`).permissions?.push)
          throw new Error();
        return "push allowed";
      },
      "Grant this GitHub account repository push/Release permissions.",
    );
    check(
      "locked frontend dependencies",
      () => {
        if (
          !existsSync(
            join(this.root, "node_modules/@tauri-apps/cli/tauri.js"),
          ) ||
          !existsSync(join(this.root, "src-tauri/Cargo.lock"))
        )
          throw new Error();
        return "manifests and local CLI present";
      },
      "Run pnpm install --frozen-lockfile; retain pnpm-lock.yaml and src-tauri/Cargo.lock.",
    );
    const installed = await readFile(
      join(this.root, "node_modules/.pnpm/lock.yaml"),
      "utf8",
    ).catch(() => null);
    const locked = await readFile(join(this.root, "pnpm-lock.yaml"), "utf8");
    checks.push({
      name: "pnpm installed lock matches repository",
      ok:
        installed?.replace(/\r\n/g, "\n").trim() ===
        locked.replace(/\r\n/g, "\n").trim(),
      fix: "Run pnpm install --frozen-lockfile.",
    });
    this.log(JSON.stringify(checks, null, 2));
    if (checks.some((c) => !c.ok))
      throw new Error(
        "Release doctor found issues; follow the fix instructions above",
      );
    return checks;
  }
}

/** 根据显式子命令执行一个阶段，不自动继续合并、发布或提升正式版。 */
export async function main(args = process.argv.slice(2), options = {}) {
  const parsed = parseArguments(args);
  const manager = new ReleaseManager({
    ...options,
    dryRun: parsed.dryRun,
    timeoutMs: parsed.timeoutMs,
  });
  if (parsed.command === "doctor") return manager.doctor();
  if (parsed.command === "verify")
    return manager.verify(parsed.tag, parsed.download);
  return manager[parsed.command](parsed.tag);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
