import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertHost,
  buildArguments,
  collectPackage,
  dispatchPackage,
  installCommand,
  localPlatform,
  packageMatrix,
  verifyPackage,
} from "./package.mjs";
import { targets } from "./release.mjs";

/** 为产物测试创建独立 Git 仓库和匹配当前版本的最小 Tauri 目录。 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "power-switch-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), '{"version":"0.1.7"}');
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "package.json"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Package Test",
    "-c",
    "user.email=package@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  return root;
}

/** 为指定平台生成一个假的安装包，测试收集而不实际编译应用。 */
async function installer(root, name, extension, contents = "installer") {
  const directory = join(
    root,
    "src-tauri",
    "target",
    targets[name].triple,
    "release",
    "bundle",
    "fixture",
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, `power-switch.${extension}`);
  await writeFile(path, contents);
  return path;
}

test("maps all five native targets to runners, bundles and local hosts", () => {
  const matrix = packageMatrix();
  assert.equal(matrix.include.length, 5);
  assert.deepEqual(
    new Set(matrix.include.map((entry) => entry.platform)),
    new Set(Object.keys(targets)),
  );
  assert.equal(localPlatform("darwin", "arm64"), "macos-universal");
  assert.equal(localPlatform("darwin", "x64"), "macos-universal");
  assert.equal(localPlatform("win32", "arm64"), "windows-arm64");
  assert.equal(localPlatform("linux", "x64"), "linux-x64");
  assert.throws(() => localPlatform("freebsd", "x64"), /Unsupported/);
  assert.throws(() => assertHost("windows-arm64", "win32", "x64"), /requires/);
  assert.throws(() => assertHost("linux-x64", "darwin", "arm64"), /requires/);
  assert.throws(() => assertHost("unknown"), /Unknown/);
  for (const name of Object.keys(targets)) {
    const args = buildArguments(name);
    assert.ok(args.includes(targets[name].triple));
    assert.equal(args[0], "build");
    assert.ok(args.includes(targets[name].bundles));
    assert.ok(args.includes("--no-sign"));
    assert.ok(args.includes('{"bundle":{"createUpdaterArtifacts":false}}'));
    assert.deepEqual(args.slice(-2), ["--", "--locked"]);
  }
});

test("runs pnpm.cmd through cmd.exe on Windows and pnpm directly elsewhere", () => {
  assert.deepEqual(installCommand("win32"), [
    "cmd.exe",
    ["/d", "/s", "/c", "pnpm install --frozen-lockfile"],
  ]);
  assert.deepEqual(installCommand("darwin"), [
    "pnpm",
    ["install", "--frozen-lockfile"],
  ]);
});

test("collects each Linux installer and verifies the generated checksums", async (t) => {
  const root = await fixture(t);
  for (const extension of targets["linux-x64"].installers)
    await installer(root, "linux-x64", extension);
  const directory = await collectPackage("linux-x64", root);
  await verifyPackage(directory, "linux-x64");
  const checksums = await readFile(join(directory, "SHA256SUMS"), "utf8");
  assert.equal(checksums.trim().split("\n").length, 3);
  assert.match(directory, /v0\.1\.7-[a-f0-9]{12}-dirty/);
  const name = checksums.split("\n")[0].slice(66);
  await writeFile(join(directory, name), "tampered");
  await assert.rejects(
    verifyPackage(directory, "linux-x64"),
    /checksum failed/,
  );
});

test("missing, duplicate and empty installer files fail before staging", async (t) => {
  const root = await fixture(t);
  await assert.rejects(collectPackage("windows-x64", root), /ENOENT/);
  const path = await installer(root, "windows-x64", "msi", "");
  await assert.rejects(
    collectPackage("windows-x64", root),
    /Invalid package file/,
  );
  await writeFile(path, "msi");
  const other = join(
    root,
    "src-tauri",
    "target",
    targets["windows-x64"].triple,
    "release",
    "bundle",
    "other",
  );
  await mkdir(other);
  await writeFile(join(other, "another.msi"), "msi");
  await assert.rejects(collectPackage("windows-x64", root), /Expected one/);
});

test(
  "linked installer files are rejected",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await fixture(t);
    const path = await installer(root, "windows-x64", "msi");
    const other = join(
      root,
      "src-tauri",
      "target",
      targets["windows-x64"].triple,
      "release",
      "bundle",
      "other",
    );
    await mkdir(other);
    await symlink(path, join(other, "linked.msi"));
    await assert.rejects(
      collectPackage("windows-x64", root),
      /Invalid package file/,
    );
  },
);

test("cloud dispatch rejects a branch other than the checked-out branch", () => {
  assert.throws(
    () => dispatchPackage("another-branch"),
    /Check out the branch/,
  );
});

test("package workflow only uploads test artifacts and does not publish a release", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/package.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /scripts\/package\.mjs matrix/);
  assert.match(workflow, /scripts\/package\.mjs build/);
  assert.match(workflow, /scripts\/package\.mjs collect/);
  assert.doesNotMatch(
    workflow,
    /gh release|publish-release|contents: write|TAURI_SIGNING_PRIVATE_KEY/,
  );
});

test("test packaging targets stay aligned with the existing release matrix", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  for (const [name, target] of Object.entries(targets)) {
    const entry = [
      `- platform: ${name}`,
      `os: ${target.runner}`,
      `target: ${target.triple}`,
      `rust-targets: ${target.rustTargets}`,
      `bundles: ${target.bundles}`,
    ].join("\\s+");
    assert.match(workflow, new RegExp(entry));
  }
});
