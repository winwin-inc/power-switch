import assert from "node:assert/strict";
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
  checkVersion,
  expectedAssets,
  expectedSignatures,
  packageVersion,
  updaterArtifactExtension,
  validateAssets,
  versionFromTag,
  writeChecksums,
} from "./release.mjs";
import { assertPublishable, writeUpdaterManifest } from "./publish-release.mjs";

/** 为每个测试创建隔离目录，并在测试结束后删除测试自身的数据。 */
async function temporaryDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "power-switch-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** 创建最小版本清单夹具，不依赖实际仓库内容。 */
async function versionFixture(t) {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "src-tauri"));
  await writeFile(join(root, "package.json"), '{"version":"0.1.0"}');
  await writeFile(
    join(root, "src-tauri/tauri.conf.json"),
    '{"version":"0.1.0"}',
  );
  await writeFile(
    join(root, "src-tauri/Cargo.toml"),
    '[package]\nname = "power-switch"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
  );
  await writeFile(
    join(root, "src-tauri/Cargo.lock"),
    'version = 4\n\n[[package]]\nname = "other"\nversion = "2.0.0"\n\n[[package]]\nname = "power-switch"\nversion = "0.1.0"\n',
  );
  return root;
}

/** 生成一套具有已知校验值的虚拟发布文件。 */
async function assetFixture(t) {
  const directory = await temporaryDirectory(t);
  for (const name of expectedAssets("v0.1.0"))
    await writeFile(join(directory, name), "abc");
  for (const name of expectedSignatures("v0.1.0"))
    await writeFile(join(directory, name), "signature");
  return directory;
}

test("accepts SemVer stable, prerelease and build metadata", () => {
  for (const tag of ["v0.1.0", "v1.2.3-rc.1", "v1.2.3-beta.0+build.01"])
    assert.equal(versionFromTag(tag), tag.slice(1));
});

test("rejects invalid versions and path injection", () => {
  for (const tag of [
    undefined,
    "0.1.0",
    "v01.2.3",
    "v1.2",
    "v1.2.3-01",
    "v1.2.3-",
    "v1.2.3/evil",
    "v1.2.3\n",
    "v1.2.3;echo",
  ])
    assert.throws(() => versionFromTag(tag));
});

test("requires consistent versions across all four manifests", async (t) => {
  const root = await versionFixture(t);
  assert.equal(await checkVersion(root, "v0.1.0"), "0.1.0");
  await assert.rejects(checkVersion(root, "v0.2.0"), /does not match/);
});

for (const file of [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
]) {
  test(`detects stale version in ${file}`, async (t) => {
    const root = await versionFixture(t);
    const path = join(root, file);
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("0.1.0", "0.0.9"),
    );
    await assert.rejects(checkVersion(root, "v0.1.0"), /does not match/);
  });
}

test("does not use another crate's version or ambiguous package tables", () => {
  assert.throws(() =>
    packageVersion('[[package]]\nname = "other"\nversion = "0.1.0"\n', true),
  );
  assert.throws(() =>
    packageVersion(
      '[package]\nname = "power-switch"\nversion.workspace = true\n',
    ),
  );
  const table = '[[package]]\nname = "power-switch"\nversion = "0.1.0"\n';
  assert.throws(() => packageVersion(table + table, true));
});

test("expects all install and updater bundles for five targets", () => {
  const names = expectedAssets("v0.1.0");
  assert.equal(names.length, 13);
  assert.equal(new Set(names).size, 13);
  assert.equal(expectedSignatures("v0.1.0").length, 5);
  assert.equal(expectedAssets("v0.1.0", "macos-universal").length, 3);
  assert.equal(expectedAssets("v0.1.0", "linux-arm64").length, 3);
  assert.throws(() => expectedAssets("v0.1.0", "unknown"));
});

test("selects the updater-supported bundle and its matching signature per platform", () => {
  assert.equal(updaterArtifactExtension("macos-universal"), "tar.gz");
  assert.equal(updaterArtifactExtension("windows-x64"), "msi");
  assert.equal(updaterArtifactExtension("windows-arm64"), "msi");
  assert.equal(updaterArtifactExtension("linux-x64"), "AppImage");
  assert.equal(updaterArtifactExtension("linux-arm64"), "AppImage");
  assert.throws(
    () => updaterArtifactExtension("unknown"),
    /Unknown release platform/,
  );
});

test("generates a signed updater manifest for all supported OS architectures", async (t) => {
  const directory = await assetFixture(t);
  await writeUpdaterManifest(directory, "winwin-inc/power-switch", "v0.1.0");
  const manifest = JSON.parse(
    await readFile(join(directory, "latest.json"), "utf8"),
  );
  assert.equal(manifest.version, "v0.1.0");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-aarch64",
    "windows-x86_64",
  ]);
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    "https://github.com/winwin-inc/power-switch/releases/download/v0.1.0/power-switch-v0.1.0-macos-universal.tar.gz",
  );
  assert.equal(manifest.platforms["windows-x86_64"].signature, "signature");
});

test("generates known SHA-256 values and permits verification on rerun", async (t) => {
  const directory = await assetFixture(t);
  await writeChecksums(directory, "v0.1.0");
  const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
  assert.equal(sums.trim().split("\n").length, 13);
  assert.ok(
    sums
      .split("\n")
      .filter(Boolean)
      .every((line) =>
        line.startsWith(
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  ",
        ),
      ),
  );
  await writeChecksums(directory, "v0.1.0");
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), sums);
});

test("missing platform package prevents checksum generation", async (t) => {
  const directory = await assetFixture(t);
  await rm(join(directory, expectedAssets("v0.1.0")[0]));
  await assert.rejects(writeChecksums(directory, "v0.1.0"), /mismatch/);
  await assert.rejects(readFile(join(directory, "SHA256SUMS")), {
    code: "ENOENT",
  });
});

test("unexpected assets prevent publishing", async (t) => {
  const directory = await assetFixture(t);
  await writeFile(join(directory, "unrelated.zip"), "unexpected");
  await assert.rejects(validateAssets(directory, "v0.1.0"), /mismatch/);
});

test("empty and non-file assets prevent publishing", async (t) => {
  const directory = await assetFixture(t);
  const path = join(directory, expectedAssets("v0.1.0")[0]);
  await writeFile(path, "");
  await assert.rejects(
    validateAssets(directory, "v0.1.0"),
    /nonempty regular file/,
  );
  await rm(path);
  await mkdir(path);
  await assert.rejects(
    validateAssets(directory, "v0.1.0"),
    /nonempty regular file/,
  );
});

test(
  "symlink assets are rejected",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await assetFixture(t);
    const names = expectedAssets("v0.1.0");
    await rm(join(directory, names[0]));
    await symlink(join(directory, names[1]), join(directory, names[0]));
    await assert.rejects(
      validateAssets(directory, "v0.1.0"),
      /nonempty regular file/,
    );
  },
);

test("stable releases cannot be overwritten and tags cannot switch commits", () => {
  assert.doesNotThrow(() => assertPublishable(null, "abc"));
  assert.doesNotThrow(() =>
    assertPublishable(
      { draft: true, prerelease: true, target_commitish: "abc" },
      "abc",
    ),
  );
  assert.doesNotThrow(() =>
    assertPublishable(
      { draft: false, prerelease: true, target_commitish: "abc" },
      "abc",
    ),
  );
  assert.throws(
    () =>
      assertPublishable(
        { draft: false, prerelease: false, target_commitish: "abc" },
        "abc",
      ),
    /stable release/,
  );
  assert.doesNotThrow(() =>
    assertPublishable(
      {
        draft: false,
        prerelease: false,
        assets: [],
        target_commitish: "master",
      },
      "abc",
      true,
    ),
  );
  assert.throws(
    () =>
      assertPublishable(
        { draft: false, prerelease: false, assets: [{ name: "existing.dmg" }] },
        "abc",
        true,
      ),
    /stable release/,
  );
  assert.throws(
    () => assertPublishable({ draft: true, target_commitish: "other" }, "abc"),
    /different commit/,
  );
});
