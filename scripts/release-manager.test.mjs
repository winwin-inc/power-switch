import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ReleaseManager,
  compareVersions,
  nextMsiVersion,
  parseArguments,
  parseChecksums,
  releaseFiles,
  replacePackageVersion,
  validatePublishedRelease,
} from "./release-manager.mjs";
import { expectedAssets, verifyMacArchitectures } from "./release.mjs";
import { writeUpdaterManifest } from "./publish-release.mjs";

const repo = "winwin-inc/power-switch";
const tag = "v0.1.11";
const otherSha = "f".repeat(40);

/** 在系统临时目录创建真实 Git 仓库，所有测试只操作该目录。 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "power-switch-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src-tauri"));
  await mkdir(join(root, ".github"));
  const contents = {
    "package.json":
      '{"name":"power-switch","version":"0.1.10","packageManager":"pnpm@10.18.3"}\n',
    "src-tauri/tauri.conf.json":
      '{"version":"0.1.10","bundle":{"windows":{"wix":{"version":"0.1.11.0"}}}}\n',
    "src-tauri/Cargo.toml":
      '[package]\nname = "power-switch"\nversion = "0.1.10"\n\n[dependencies]\nother = "0.1.10"\n',
    "src-tauri/Cargo.lock":
      'version = 4\n\n[[package]]\nname = "other"\nversion = "0.1.10"\n\n[[package]]\nname = "power-switch"\nversion = "0.1.10"\n',
    ".github/RELEASE_TEMPLATE.md":
      "## power-switch\n\n### 本次更新\n\n- Old release\n\n### 下载选择\n\nDownload links\n",
    ".gitignore": "artifacts/\nnode_modules/\n.env*\n.venv/\nvenv/\n",
  };
  for (const [file, text] of Object.entries(contents))
    await writeFile(join(root, file), text);
  /** 为每次测试 Git 命令指定临时身份，覆盖提交和标签且不修改用户配置。 */
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=release@example.invalid",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  git("init", "-q", "--initial-branch=master");
  git("add", "--", ...Object.keys(contents));
  git("commit", "-qm", "fixture");
  git("remote", "add", "origin", `git@github.com:${repo}.git`);
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  const calls = [],
    logs = [];
  const state = { prs: [], runs: [], refs: {}, clock: 0, api: null };
  const run = (program, args, options) => {
    calls.push([program, ...args]);
    if (program === "git") {
      if (args[0] === "push") {
        const ref = args.find((arg) => arg.startsWith("refs/tags/"));
        if (ref)
          state.refs[ref.replace("refs/", "")] = git(
            "rev-parse",
            `${ref}^{commit}`,
          );
        return "";
      }
      if (args[0] === "fetch") return "";
      return git(...args);
    }
    assert.equal(program, "gh", `Unexpected process: ${program}`);
    if (args[0] === "pr" && args[1] === "list")
      return JSON.stringify(state.prs);
    if (args[0] === "pr" && args[1] === "create") {
      state.prs = [
        {
          number: 23,
          url: `https://github.com/${repo}/pull/23`,
          state: "OPEN",
          headRefOid: git("rev-parse", "HEAD"),
          isCrossRepository: false,
        },
      ];
      return state.prs[0].url;
    }
    if (args[0] === "pr" && args[1] === "view")
      return JSON.stringify({
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      });
    if (args[0] === "pr" && args[1] === "merge") {
      state.prs[0].state = "MERGED";
      return "";
    }
    if (args[0] === "api") {
      const path = args[1];
      if (state.api) {
        const value = state.api(path);
        if (value !== undefined) return JSON.stringify(value);
      }
      if (path.includes("/actions/workflows/"))
        return JSON.stringify({ workflow_runs: state.runs });
      if (path.includes("/git/ref/")) {
        const name = path.split("/git/ref/")[1];
        if (state.refs[name])
          return JSON.stringify({
            object: { type: "commit", sha: state.refs[name] },
          });
        const error = new Error("HTTP 404");
        error.stderr = "HTTP 404";
        throw error;
      }
    }
    if (state.other) return state.other(program, args, options);
    throw new Error(`Unmocked GitHub call: ${args.join(" ")}`);
  };
  const manager = new ReleaseManager({
    root,
    run,
    log: (message) => logs.push(message),
    now: () => state.clock,
    wait: async (ms) => {
      state.clock += ms;
    },
    timeoutMs: 30000,
  });
  return { root, git, calls, logs, state, manager };
}

/** 生成与指定仓库、分支、提交完全绑定的工作流响应。 */
function workflow(
  sha,
  {
    workflow = "ci.yml",
    branch = "master",
    event = "push",
    status = "completed",
    conclusion = "success",
    id = 100,
    ...extra
  } = {},
) {
  return {
    id,
    run_attempt: 1,
    repository: { full_name: repo },
    head_sha: sha,
    head_branch: branch,
    event,
    path: `.github/workflows/${workflow}`,
    status,
    conclusion,
    html_url: `https://github.com/${repo}/actions/runs/${id}`,
    ...extra,
  };
}

/** 完成准备阶段的说明填写，并创建可模拟远程合并的发布提交。 */
async function prepared(t) {
  const f = await fixture(t);
  await f.manager.prepare(tag);
  const path = join(f.root, releaseFiles(tag).at(-1));
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "TODO: 填写本次变更。",
      "完善发布流程。",
    ),
  );
  return f;
}

/** 生成真实摘要的内存发布资产，用模拟下载器写入临时文件。 */
function publishedAssets(version = tag) {
  const digest = (bytes) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const assets = expectedAssets(version).map((name, i) => ({
    id: i + 1,
    name,
    body: `installer:${name}`,
  }));
  const sums =
    assets.map((a) => `${digest(a.body).slice(7)}  ${a.name}`).join("\n") +
    "\n";
  const platforms = Object.fromEntries(
    Object.entries({
      "darwin-aarch64": "macos-universal.tar.gz",
      "darwin-x86_64": "macos-universal.tar.gz",
      "windows-x86_64": "windows-x64.msi",
      "windows-aarch64": "windows-arm64.msi",
      "linux-x86_64": "linux-x64.AppImage",
      "linux-aarch64": "linux-arm64.AppImage",
    }).map(([key, suffix]) => [
      key,
      {
        url: `https://github.com/${repo}/releases/download/${version}/power-switch-${version}-${suffix}`,
        signature: Buffer.from(
          "untrusted comment: test minisign signature\nsignature data\n",
        ).toString("base64"),
      },
    ]),
  );
  const manifest = { version, pub_date: "2026-10-16T00:00:00Z", platforms };
  assets.push(
    { id: 14, name: "SHA256SUMS", body: sums },
    { id: 15, name: "latest.json", body: JSON.stringify(manifest) },
  );
  for (const asset of assets)
    Object.assign(asset, {
      size: Buffer.byteLength(asset.body),
      digest: digest(asset.body),
    });
  return {
    release: {
      id: 10,
      tag_name: version,
      draft: false,
      prerelease: true,
      html_url: `https://github.com/${repo}/releases/tag/${version}`,
    },
    assets,
    sums,
    manifest,
  };
}

/** 给真实 Git 夹具配置只读 Release API 及受控下载响应。 */
function mockRelease(f, data, version = tag) {
  const sha = f.git("rev-parse", "HEAD");
  f.state.refs[`tags/${version}`] = sha;
  f.state.runs = [workflow(sha, { workflow: "release.yml", branch: version })];
  f.state.api = (path) => {
    if (path === `repos/${repo}/releases/tags/${version}`) return data.release;
    if (path === `repos/${repo}/releases/10/assets?per_page=100`)
      return data.assets;
    if (path === `repos/${repo}/releases/latest`) return data.release;
  };
  f.state.other = (program, args) => {
    if (args[0] === "release" && args[1] === "download") {
      const directory = args[args.indexOf("--dir") + 1];
      for (let i = 0; i < args.length; i += 1)
        if (args[i] === "--pattern") {
          const name = args[++i];
          const asset = data.assets.find((a) => a.name === name);
          writeFileSync(join(directory, asset.name), asset.body);
        }
      return "";
    }
    if (args[0] === "release" && args[1] === "edit") {
      data.release.prerelease = false;
      return "";
    }
    throw new Error(`Unexpected mutation: ${args.join(" ")}`);
  };
}

test("SemVer ordering handles RC, numeric identifiers, stable and metadata", () => {
  for (const [a, b] of [
    ["v0.1.11-rc.2", "v0.1.11-rc.10"],
    ["v0.1.11-rc.10", "v0.1.11"],
    ["v0.1.11-1", "v0.1.11-alpha"],
    ["v1.0.0", "v2.0.0"],
    ["v0.1.11-a", "v0.1.11-a.1"],
  ]) {
    assert.equal(compareVersions(a, b), -1);
    assert.equal(compareVersions(b, a), 1);
  }
  assert.equal(compareVersions("v0.1.11+build.1", "v0.1.11+build.2"), 0);
  assert.throws(() => compareVersions("v01.1.0", tag));
});

test("MSI is monotonic and refuses invalid versions or overflow", () => {
  assert.equal(nextMsiVersion("0.1.11.0"), "0.1.12.0");
  for (const value of [
    "0.1.11.1",
    "0.1.11",
    "256.0.0.0",
    "0.256.0.0",
    "0.1.65535.0",
    "-1.1.1.0",
  ])
    assert.throws(() => nextMsiVersion(value));
});

test("arguments reject unknown flags, malformed tags and incompatible options", () => {
  assert.equal(parseArguments(["prepare", tag, "--dry-run"]).dryRun, true);
  assert.equal(parseArguments(["verify", tag, "--download"]).download, true);
  assert.equal(
    parseArguments(["merge", tag, "--timeout-minutes=3"]).timeoutMs,
    180000,
  );
  assert.equal(parseArguments(["prepare", tag, ""]).dryRun, false);
  for (const args of [
    ["prepare", "0.1.11"],
    ["publish", tag, "--force"],
    ["status", tag, "--dry-run"],
    ["prepare", tag, "--download"],
    ["merge", tag, "--timeout-minutes", "0"],
  ])
    assert.throws(() => parseArguments(args));
});

test("prepare synchronizes four versions, preserves dependencies and can resume", async (t) => {
  const f = await prepared(t);
  assert.equal(f.git("branch", "--show-current"), `codex/release-${tag}`);
  assert.equal(
    JSON.parse(await readFile(join(f.root, "package.json"), "utf8")).version,
    "0.1.11",
  );
  assert.equal(
    JSON.parse(
      await readFile(join(f.root, "src-tauri/tauri.conf.json"), "utf8"),
    ).bundle.windows.wix.version,
    "0.1.12.0",
  );
  assert.match(
    await readFile(join(f.root, "src-tauri/Cargo.lock"), "utf8"),
    /name = "other"\nversion = "0\.1\.10"/,
  );
  const before = await readFile(
    join(f.root, "src-tauri/tauri.conf.json"),
    "utf8",
  );
  await f.manager.prepare(tag);
  assert.equal(
    await readFile(join(f.root, "src-tauri/tauri.conf.json"), "utf8"),
    before,
  );
  assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/master"));
});

test("prepare dry-run does not create branches or modify tracked state", async (t) => {
  const f = await fixture(t);
  f.manager.dryRun = true;
  await f.manager.prepare(tag);
  assert.equal(f.git("branch", "--show-current"), "master");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.ok(
    !f.calls.some(
      (c) =>
        c[0] === "git" && ["switch", "add", "commit", "push"].includes(c[1]),
    ),
  );
});

test("dirty/unrelated staged files and old versions fail before prepare", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.manager.prepare("v0.1.9"), /greater/);
  await writeFile(join(f.root, "unrelated.txt"), "user changes");
  f.git("add", "unrelated.txt");
  await assert.rejects(f.manager.prepare(tag), /Unexpected/);
  assert.equal(f.git("branch", "--show-current"), "master");
});

test("TOML replacement rejects ambiguity and preserves other package versions", () => {
  const text =
    '[[package]]\nname = "power-switch"\nversion = "0.1.10"\n\n[[package]]\nname = "another"\nversion = "0.1.10"\n';
  const updated = replacePackageVersion(text, "0.1.11", true);
  assert.match(updated, /power-switch"\nversion = "0.1.11"/);
  assert.match(updated, /another"\nversion = "0.1.10"/);
  assert.throws(() => replacePackageVersion(text + text, "0.1.11", true));
});

test("PR refuses unfinished notes and stages only the explicit release list", async (t) => {
  const f = await fixture(t);
  await f.manager.prepare(tag);
  await assert.rejects(f.manager.pr(tag), /Complete docs/);
  const path = join(f.root, releaseFiles(tag).at(-1));
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "TODO: 填写本次变更。",
      "发布脚本。",
    ),
  );
  await f.manager.pr(tag);
  const staged = f.calls.find((c) => c[0] === "git" && c[1] === "add");
  assert.deepEqual(staged.slice(3), releaseFiles(tag));
  assert.equal(f.state.prs.length, 1);
  const count = f.calls.filter(
    (c) => c[1] === "pr" && c[2] === "create",
  ).length;
  await f.manager.pr(tag);
  assert.equal(
    f.calls.filter((c) => c[1] === "pr" && c[2] === "create").length,
    count,
  );
});

test("PR rejects staged secrets, unrelated changes and a different existing head", async (t) => {
  const f = await prepared(t);
  const originalRun = f.manager.run;
  for (const path of [
    ".env",
    "nested/.env",
    "nested/.venv/file",
    "nested/venv/file",
  ]) {
    // 只模拟索引返回值：测试自身也不创建或暂存任何 .env/venv 文件。
    f.manager.run = (program, args, options) => {
      if (program === "git" && args.includes("--cached")) return `${path}\0`;
      return originalRun(program, args, options);
    };
    await assert.rejects(f.manager.pr(tag), /Unexpected/);
    assert.ok(!f.calls.some((c) => c[1] === "push"));
  }
  f.manager.run = originalRun;
  f.state.prs = [{ state: "OPEN", headRefOid: otherSha }];
  await assert.rejects(f.manager.pr(tag), /another commit/);
});

test("PR dry-run does not stage, commit, push or create a remote PR", async (t) => {
  const f = await prepared(t);
  f.manager.dryRun = true;
  const before = f.git("status", "--porcelain");
  await f.manager.pr(tag);
  assert.equal(f.git("status", "--porcelain"), before);
  assert.equal(f.state.prs.length, 0);
  assert.ok(
    !f.calls.some(
      (c) =>
        (c[0] === "git" && ["add", "commit", "push"].includes(c[1])) ||
        (c[0] === "gh" && c[1] === "pr" && c[2] === "create"),
    ),
  );
});

test("workflow selection ignores wrong repo, SHA, branch, event and workflow", async (t) => {
  const f = await fixture(t),
    sha = f.git("rev-parse", "HEAD");
  f.state.runs = [
    workflow(sha, { id: 1 }),
    workflow(otherSha, { id: 999 }),
    workflow(sha, { id: 998, branch: "wrong" }),
    workflow(sha, { id: 997, event: "workflow_dispatch" }),
    workflow(sha, { id: 996, repository: { full_name: "other/repo" } }),
    workflow(sha, { id: 995, workflow: "release.yml" }),
  ];
  assert.equal(
    (await f.manager.waitRun("ci.yml", sha, "master", ["push"])).id,
    1,
  );
});

test("failed, cancelled and timed-out CI never reaches merge", async (t) => {
  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
    const f = await fixture(t),
      sha = f.git("rev-parse", "HEAD");
    f.state.prs = [{ number: 23, state: "OPEN", headRefOid: sha }];
    f.state.runs = [
      workflow(sha, {
        branch: `codex/release-${tag}`,
        event: "pull_request",
        conclusion,
      }),
    ];
    await assert.rejects(f.manager.merge(tag), /Recover: gh run rerun/);
    assert.ok(!f.calls.some((c) => c[1] === "pr" && c[2] === "merge"));
  }
});

test("wait timeout and missing workflow creation are bounded and recoverable", async (t) => {
  const f = await fixture(t),
    sha = f.git("rev-parse", "HEAD");
  f.state.runs = [workflow(sha, { status: "in_progress", conclusion: null })];
  await assert.rejects(
    f.manager.waitRun("ci.yml", sha, "master", ["push"]),
    /Timed out/,
  );
  assert.equal(f.state.clock, 30000);
  f.state.clock = 0;
  f.state.runs = [];
  f.manager.timeoutMs = 180000;
  await assert.rejects(
    f.manager.waitRun("ci.yml", sha, "master", ["push"]),
    /Workflow not found/,
  );
  assert.ok(f.state.clock <= 135000);
});

test("merge uses the full checked SHA and rejects a head changed during waiting", async (t) => {
  const f = await fixture(t),
    sha = f.git("rev-parse", "HEAD");
  f.state.prs = [{ number: 23, state: "OPEN", headRefOid: sha }];
  f.state.runs = [
    workflow(sha, { branch: `codex/release-${tag}`, event: "pull_request" }),
  ];
  await f.manager.merge(tag);
  const call = f.calls.find((c) => c[1] === "pr" && c[2] === "merge");
  assert.equal(call[call.indexOf("--match-head-commit") + 1], sha);
  f.state.prs[0].state = "OPEN";
  f.manager.waitRun = async () => {
    f.state.prs[0].headRefOid = otherSha;
  };
  await assert.rejects(f.manager.merge(tag), /head changed/);
});

test("publish resumes the matching existing tag/run without a second tag push", async (t) => {
  const f = await prepared(t);
  await f.manager.pr(tag);
  const sha = f.git("rev-parse", "HEAD");
  f.git("update-ref", "refs/remotes/origin/master", sha);
  f.state.prs[0] = {
    ...f.state.prs[0],
    state: "MERGED",
    mergeCommit: { oid: sha },
  };
  f.state.refs[`tags/${tag}`] = sha;
  f.state.runs = [
    workflow(sha),
    workflow(sha, { workflow: "release.yml", branch: tag, id: 101 }),
  ];
  f.state.api = (path) =>
    path === `repos/${repo}/releases/tags/${tag}`
      ? publishedAssets().release
      : undefined;
  f.calls.length = 0;
  await f.manager.publish(tag);
  await f.manager.publish(tag);
  assert.ok(
    !f.calls.some((c) => c[0] === "git" && ["tag", "push"].includes(c[1])),
  );
  f.state.refs[`tags/${tag}`] = otherSha;
  await assert.rejects(f.manager.publish(tag), /another commit/);
});

test("publish dry-run leaves tags and workflows untouched", async (t) => {
  const f = await fixture(t),
    sha = f.git("rev-parse", "HEAD");
  f.state.prs = [{ state: "MERGED", mergeCommit: { oid: sha } }];
  f.manager.dryRun = true;
  await f.manager.publish(tag);
  assert.equal(f.git("tag", "--list"), "");
  assert.ok(
    !f.calls.some(
      (c) => c[0] === "git" && ["fetch", "tag", "push"].includes(c[1]),
    ),
  );
});

test("asset verification rejects omissions, duplicates, digests and bad updater fields", () => {
  const data = publishedAssets();
  assert.equal(
    validatePublishedRelease(
      data.release,
      data.assets,
      data.sums,
      data.manifest,
      tag,
    ).assetCount,
    15,
  );
  for (const alter of [
    (d) => d.assets.pop(),
    (d) => d.assets.push(d.assets[0]),
    (d) => {
      d.assets[0].digest = "sha256:" + "0".repeat(64);
    },
    (d) => {
      d.manifest.version = "v0.1.10";
    },
    (d) => {
      delete d.manifest.platforms["linux-aarch64"];
    },
    (d) => {
      d.manifest.platforms["windows-x86_64"].url =
        "https://example.invalid/installer.msi";
    },
    (d) => {
      d.manifest.platforms["darwin-aarch64"].signature = "";
    },
    (d) => {
      d.release.draft = true;
    },
  ]) {
    const changed = structuredClone(data);
    alter(changed);
    assert.throws(() =>
      validatePublishedRelease(
        changed.release,
        changed.assets,
        changed.sums,
        changed.manifest,
        tag,
      ),
    );
  }
  assert.throws(
    () => parseChecksums(data.sums + data.sums.split("\n")[0], tag),
    /duplicate/,
  );
  assert.throws(
    () =>
      parseChecksums(
        data.sums.replace(/power-switch-/, "../power-switch-"),
        tag,
      ),
    /Invalid/,
  );
});

test("verify checks downloaded bytes and writes an explicit acceptance report", async (t) => {
  const f = await fixture(t),
    data = publishedAssets();
  mockRelease(f, data);
  const report = await f.manager.verify(tag, true);
  assert.equal(report.mode, "downloaded-all-assets");
  assert.equal(report.manualInstallationAcceptance, "not-performed");
  assert.equal((await readdir(report.downloadDirectory)).length, 16);
  assert.ok(!f.calls.some((c) => c[1] === "release" && c[2] === "edit"));
});

test("verify refuses corrupt downloads and assets changed during verification", async (t) => {
  const f = await fixture(t),
    data = publishedAssets();
  mockRelease(f, data);
  data.assets.find((a) => a.name === "latest.json").body += "tampered";
  await assert.rejects(f.manager.verify(tag), /Downloaded checksum/);
  const good = publishedAssets();
  mockRelease(f, good);
  let reads = 0;
  f.state.api = (path) => {
    if (path.includes("/assets?")) {
      reads += 1;
      const assets = structuredClone(good.assets);
      if (reads > 1) assets[0].id += 100;
      return assets;
    }
    if (path.includes("/releases/tags/")) return good.release;
  };
  await assert.rejects(f.manager.verify(tag), /changed during verification/);
});

test("promote verifies first, protects RC/Latest ordering and confirms readback", async (t) => {
  const f = await fixture(t),
    data = publishedAssets();
  mockRelease(f, data);
  await f.manager.promote(tag);
  assert.equal(data.release.prerelease, false);
  const download = f.calls.findIndex(
    (c) => c[1] === "release" && c[2] === "download",
  );
  const edit = f.calls.findIndex((c) => c[1] === "release" && c[2] === "edit");
  assert.ok(download >= 0 && edit > download);
  await assert.rejects(f.manager.promote("v0.1.12-rc.1"), /cannot be promoted/);
  data.release.tag_name = "v0.1.12";
  await assert.rejects(f.manager.promote(tag), /downgrade/);
});

test("promote dry-run and failed verification never edit a release", async (t) => {
  const f = await fixture(t),
    data = publishedAssets();
  mockRelease(f, data);
  f.manager.dryRun = true;
  await f.manager.promote(tag);
  assert.ok(
    !f.calls.some(
      (c) => c[1] === "release" && ["edit", "download"].includes(c[2]),
    ),
  );
  f.manager.dryRun = false;
  data.manifest.platforms = {};
  data.assets.find((a) => a.name === "SHA256SUMS").body = "bad manifest";
  await assert.rejects(f.manager.promote(tag));
  assert.ok(!f.calls.some((c) => c[1] === "release" && c[2] === "edit"));
});

test("API only treats 404 as missing and propagates authentication errors", async (t) => {
  const f = await fixture(t);
  f.state.api = () => {
    const error = new Error("HTTP 403");
    error.stderr = "HTTP 403";
    throw error;
  };
  assert.throws(() => f.manager.api("any", true), /403/);
});

test("updater timestamps are deterministic and invalid dates are rejected", async (t) => {
  const f = await fixture(t),
    directory = join(f.root, "signatures");
  await mkdir(directory);
  for (const platform of [
    "macos-universal",
    "windows-x64",
    "windows-arm64",
    "linux-x64",
    "linux-arm64",
  ])
    await writeFile(
      join(directory, `power-switch-${tag}-${platform}.sig`),
      "signature",
    );
  const date = "2026-10-16T08:00:00+08:00";
  await writeUpdaterManifest(directory, repo, tag, date);
  const first = await readFile(join(directory, "latest.json"), "utf8");
  await writeUpdaterManifest(directory, repo, tag, date);
  assert.equal(await readFile(join(directory, "latest.json"), "utf8"), first);
  assert.equal(JSON.parse(first).pub_date, "2026-10-16T00:00:00.000Z");
  await assert.rejects(
    writeUpdaterManifest(directory, repo, tag, "invalid"),
    /timestamp/,
  );
});

test("macOS universal check uses archs and rejects a single-architecture binary", () => {
  verifyMacArchitectures("app/binary", (program, args) => {
    assert.equal(program, "lipo");
    assert.deepEqual(args, ["-archs", "app/binary"]);
    return "x86_64 arm64\n";
  });
  assert.throws(
    () => verifyMacArchitectures("app/binary", () => "arm64\n"),
    /Expected macOS/,
  );
});

test("publish creates one annotated tag and never tags the advanced master tip", async (t) => {
  const f = await prepared(t);
  await f.manager.pr(tag);
  const releaseSha = f.git("rev-parse", "HEAD");
  f.state.prs[0] = {
    ...f.state.prs[0],
    state: "MERGED",
    mergeCommit: { oid: releaseSha },
  };
  await writeFile(join(f.root, "later.txt"), "later feature");
  f.git("add", "later.txt");
  f.git(
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release@example.invalid",
    "commit",
    "-qm",
    "later feature",
  );
  f.git("update-ref", "refs/remotes/origin/master", "HEAD");
  f.state.runs = [
    workflow(releaseSha),
    workflow(releaseSha, { workflow: "release.yml", branch: tag, id: 101 }),
  ];
  f.state.api = (path) =>
    path === `repos/${repo}/releases/tags/${tag}`
      ? publishedAssets().release
      : undefined;
  await f.manager.publish(tag);
  assert.equal(f.git("rev-parse", `${tag}^{commit}`), releaseSha);
  assert.notEqual(f.git("rev-parse", "HEAD"), releaseSha);
  assert.equal(f.git("cat-file", "-t", tag), "tag");
  await f.manager.publish(tag);
  assert.equal(
    f.calls.filter(
      (c) =>
        c[0] === "git" && c[1] === "push" && c.includes(`refs/tags/${tag}`),
    ).length,
    1,
  );
});

test("publish refuses a conflicting local tag before pushing any tag", async (t) => {
  const f = await prepared(t);
  const original = f.git("rev-parse", "HEAD");
  await f.manager.pr(tag);
  const sha = f.git("rev-parse", "HEAD");
  f.git("update-ref", "refs/remotes/origin/master", sha);
  f.state.prs[0] = {
    ...f.state.prs[0],
    state: "MERGED",
    mergeCommit: { oid: sha },
  };
  f.state.runs = [workflow(sha)];
  f.git("tag", tag, original);
  await assert.rejects(f.manager.publish(tag), /Local tag points/);
  assert.ok(
    !f.calls.some(
      (c) =>
        c[0] === "git" && c[1] === "push" && c.includes(`refs/tags/${tag}`),
    ),
  );
});

test("merge dry-run never waits or merges and multiple PRs are refused", async (t) => {
  const f = await fixture(t),
    sha = f.git("rev-parse", "HEAD");
  f.state.prs = [{ state: "OPEN", number: 23, headRefOid: sha }];
  f.manager.dryRun = true;
  await f.manager.merge(tag);
  assert.ok(
    !f.calls.some(
      (c) =>
        (c[1] === "api" && c[2].includes("/actions/")) ||
        (c[1] === "pr" && c[2] === "merge"),
    ),
  );
  f.state.prs.push({ ...f.state.prs[0], number: 24 });
  assert.throws(() => f.manager.findPr(tag), /Multiple/);
});

test("status resolves annotated tags and reports failed platform jobs without writes", async (t) => {
  const f = await fixture(t),
    sha = f.git("rev-parse", "HEAD");
  f.state.api = (path) => {
    if (path.includes("/git/ref/tags/"))
      return { object: { type: "tag", sha: otherSha } };
    if (path.includes("/git/tags/")) return { object: { type: "commit", sha } };
    if (path.includes("/releases/tags/")) return publishedAssets().release;
    if (path.includes("/jobs?"))
      return {
        jobs: [
          {
            name: "Bundle (windows-x64)",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/job/1",
          },
        ],
      };
  };
  f.state.runs = [
    workflow(sha, {
      workflow: "release.yml",
      branch: tag,
      conclusion: "failure",
    }),
  ];
  const status = await f.manager.status(tag);
  assert.equal(status.sha, sha);
  assert.equal(status.jobs[0].conclusion, "failure");
  assert.ok(
    !f.calls.some(
      (c) =>
        c[0] === "git" &&
        ["fetch", "add", "commit", "push", "tag"].includes(c[1]),
    ),
  );
});

test("doctor reports all environment problems with fixes and performs no mutations", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "pnpm-lock.yaml"), "lock\n");
  const logs = [];
  const manager = new ReleaseManager({
    root: f.root,
    log: (value) => logs.push(value),
    run: (program, args, options) => {
      if (program === "git") return execFileSync(program, args, options);
      if (program === "node") return "v24.0.0";
      if (program === "pnpm") return "12.0.0";
      if (program === "rustc") return "rustc 1.91.0";
      if (program === "cargo") return "cargo 1.91.0";
      if (program === "just") return "just 1.40.0";
      if (program === "gh" && args[0] === "--version") return "gh 2.70.0";
      if (program === "gh" && args[0] === "auth")
        throw new Error("not authenticated");
      if (program === "gh" && args[0] === "api")
        return JSON.stringify({ permissions: { push: false } });
      throw new Error("Unexpected doctor command");
    },
  });
  await assert.rejects(manager.doctor(), /doctor found issues/);
  const failures = JSON.parse(logs[0]).filter((c) => !c.ok);
  assert.ok(failures.some((c) => c.name === "Node.js 22"));
  assert.ok(failures.some((c) => c.name === "Rust >= 1.92.0"));
  assert.ok(failures.some((c) => c.name === "GitHub authentication"));
  assert.ok(failures.every((c) => c.fix));
  assert.equal(f.git("branch", "--show-current"), "master");
});

test("promote rechecks Latest after downloads and refuses a concurrent newer release", async (t) => {
  const f = await fixture(t),
    data = publishedAssets();
  mockRelease(f, data);
  let reads = 0;
  const api = f.state.api;
  f.state.api = (path) => {
    if (path === `repos/${repo}/releases/latest` && ++reads > 1)
      return { ...data.release, tag_name: "v0.1.12" };
    return api(path);
  };
  await assert.rejects(f.manager.promote(tag), /Latest advanced/);
  assert.ok(!f.calls.some((c) => c[1] === "release" && c[2] === "edit"));
});

test("published stable releases remain verifiable after a later refused rerun", async (t) => {
  const f = await fixture(t),
    data = publishedAssets();
  mockRelease(f, data);
  f.state.runs.push(
    workflow(f.git("rev-parse", "HEAD"), {
      workflow: "release.yml",
      branch: tag,
      id: 101,
      conclusion: "failure",
    }),
  );
  const result = await f.manager.verify(tag);
  assert.equal(result.assetCount, 15);
});
