import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { arch, platform as operatingSystem } from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersion, targets, versionFromTag } from "./release.mjs";

const repository = "winwin-inc/power-switch";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 将唯一的平台配置转换为 GitHub Actions 的原生运行器矩阵。 */
export function packageMatrix() {
  return {
    include: Object.entries(targets).map(([name, target]) => ({
      platform: name,
      os: target.runner,
      rustTargets: target.rustTargets,
    })),
  };
}

/** 按当前系统和 CPU 架构选择可在本机打包的平台。 */
export function localPlatform(host = operatingSystem, cpu = arch) {
  const match = Object.entries(targets).find(
    ([, target]) =>
      target.host === host && (!target.arch || target.arch === cpu),
  );
  if (!match) throw new Error(`Unsupported packaging host: ${host}/${cpu}`);
  return match[0];
}

/** 拒绝在不匹配的主机上运行原生安装器构建。 */
export function assertHost(name, host = operatingSystem, cpu = arch) {
  const target = targets[name];
  if (!target) throw new Error(`Unknown package platform: ${name}`);
  if (target.host !== host || (target.arch && target.arch !== cpu)) {
    throw new Error(
      `${name} requires ${target.host}/${target.arch ?? "any"}; found ${host}/${cpu}`,
    );
  }
  return target;
}

/** 构造无更新器签名、固定目标架构的测试安装包命令。 */
export function buildArguments(name) {
  const target = targets[name];
  if (!target) throw new Error(`Unknown package platform: ${name}`);
  return [
    "tauri",
    "build",
    "--ci",
    "--target",
    target.triple,
    "--bundles",
    target.bundles,
    "--config",
    JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
    "--no-sign",
    "--",
    "--locked",
  ];
}

/** 检查项目依赖和 Rust 目标，缺项时在耗时构建前失败。 */
export function assertBuildPrerequisites(name, options = {}) {
  const target = assertHost(name, options.host, options.cpu);
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const missing = target.rustTargets
    .split(",")
    .filter(
      (rustTarget) =>
        !existsSync(join(sysroot, "lib", "rustlib", rustTarget, "lib")),
    );
  if (missing.length) {
    throw new Error(
      `Missing Rust target(s): ${missing.join(", ")}. Install a rustup-managed toolchain, then run rustup target add ${missing.join(" ")}`,
    );
  }
}

/** 在当前系统执行测试安装器构建，不读取更新签名私钥。 */
export async function buildPackage(name) {
  assertBuildPrerequisites(name);
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  await checkVersion(root, `v${manifest.version}`);
  await lstat(join(root, "node_modules", ".bin", "tauri")).catch(() => {
    throw new Error(
      "Missing frontend dependencies. Run pnpm install --frozen-lockfile.",
    );
  });
  execFileSync("pnpm", buildArguments(name), { cwd: root, stdio: "inherit" });
}

/** 安装锁定依赖后在本机完成构建和收集。 */
export async function packageHere(name) {
  assertBuildPrerequisites(name);
  execFileSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: root,
    stdio: "inherit",
  });
  await buildPackage(name);
  return collectPackage(name);
}

/** 只收集一个非空普通安装包，拒绝陈旧的重复产物或符号链接。 */
async function findInstaller(directory, extension) {
  const matches = [];
  /** 在打包目录内递归查找扩展名匹配的普通文件。 */
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(`.${extension}`)) {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size === 0)
          throw new Error(`Invalid package file: ${path}`);
        matches.push(path);
      }
    }
  }
  await visit(directory);
  if (matches.length !== 1)
    throw new Error(
      `Expected one .${extension} in ${directory}; found ${matches.length}`,
    );
  return matches[0];
}

/** 流式计算文件校验值，避免把大型安装包一次读入内存。 */
async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** 用版本、提交和脏工作区标识给测试包建立独立目录。 */
export async function packageIdentity(projectRoot = root) {
  const manifest = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );
  const version = versionFromTag(`v${manifest.version}`);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  ).trim();
  return `v${version}-${sha.slice(0, 12)}${dirty ? "-dirty" : ""}`;
}

/** 复制当前平台的测试安装包，并写入可独立验证的 SHA-256 清单。 */
export async function collectPackage(name, projectRoot = root) {
  const target = targets[name];
  if (!target) throw new Error(`Unknown package platform: ${name}`);
  const identity = await packageIdentity(projectRoot);
  const base = join(
    projectRoot,
    "src-tauri",
    "target",
    target.triple,
    "release",
    "bundle",
  );
  if (name === "macos-universal") {
    execFileSync(
      "lipo",
      [
        join(
          base,
          "macos",
          "power-switch.app",
          "Contents",
          "MacOS",
          "power-switch",
        ),
        "-verify_arch",
        "x86_64",
        "arm64",
      ],
      { stdio: "inherit" },
    );
  }
  const sources = [];
  for (const extension of target.installers)
    sources.push([extension, await findInstaller(base, extension)]);
  const directory = process.env.PACKAGE_OUTPUT_DIR
    ? resolve(projectRoot, process.env.PACKAGE_OUTPUT_DIR)
    : join(projectRoot, "artifacts", "packages", identity, name);
  await mkdir(directory, { recursive: true });
  const lines = [];
  for (const [extension, source] of sources) {
    const filename = `power-switch-${identity}-${name}.${extension}`;
    const destination = join(directory, filename);
    await copyFile(source, destination);
    lines.push(`${await fileHash(destination)}  ${filename}`);
  }
  await writeFile(join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
  await verifyPackage(directory, name);
  return directory;
}

/** 校验下载的工件只含预期安装包和正确的校验值。 */
export async function verifyPackage(directory, name) {
  const target = targets[name];
  if (!target) throw new Error(`Unknown package platform: ${name}`);
  const lines = (await readFile(join(directory, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n");
  if (lines.length !== target.installers.length)
    throw new Error(`Incomplete checksums for ${name}`);
  const extensions = new Set();
  for (const line of lines) {
    const match =
      /^([a-f0-9]{64})  (power-switch-[A-Za-z0-9.+-]+\.([A-Za-z0-9]+))$/.exec(
        line,
      );
    if (
      !match ||
      !target.installers.includes(match[3]) ||
      !match[2].endsWith(`-${name}.${match[3]}`) ||
      extensions.has(match[3])
    )
      throw new Error(`Invalid checksum entry for ${name}: ${line}`);
    extensions.add(match[3]);
    const path = join(directory, match[2]);
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      (await fileHash(path)) !== match[1]
    )
      throw new Error(`Package checksum failed: ${path}`);
  }
  const expected = [
    "SHA256SUMS",
    ...lines.map((line) => line.slice(66)),
  ].sort();
  const actual = (await readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Unexpected package files in ${directory}`);
}

/** 只从已推送且与当前 HEAD 一致的干净分支发起云端打包。 */
export function dispatchPackage(branch) {
  const current = execFileSync("git", ["branch", "--show-current"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const selected = branch || current;
  if (!selected || selected !== current)
    throw new Error(
      "Check out the branch to package before running package-all.",
    );
  execFileSync("git", ["check-ref-format", "--branch", selected], {
    cwd: root,
    stdio: "ignore",
  });
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    {
      cwd: root,
      encoding: "utf8",
    },
  ).trim();
  if (dirty)
    throw new Error("Commit or remove local changes before cloud packaging.");
  const localSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const remoteSha = execFileSync(
    "gh",
    [
      "api",
      `repos/${repository}/git/ref/heads/${selected}`,
      "--jq",
      ".object.sha",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  ).trim();
  if (remoteSha !== localSha)
    throw new Error(
      `Push ${selected} before cloud packaging (local ${localSha}, remote ${remoteSha}).`,
    );
  execFileSync(
    "gh",
    ["workflow", "run", "package.yml", "--repo", repository, "--ref", selected],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  console.log(
    `Packaging ${selected}@${localSha}. Find the run with: gh run list --repo ${repository} --workflow package.yml`,
  );
}

/** 下载成功的云端打包运行并逐平台核验安装包。 */
export async function downloadPackage(runId) {
  if (!/^[1-9]\d*$/.test(runId ?? ""))
    throw new Error("Expected a numeric GitHub Actions run ID.");
  const run = JSON.parse(
    execFileSync(
      "gh",
      [
        "run",
        "view",
        runId,
        "--repo",
        repository,
        "--json",
        "workflowName,status,conclusion",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    ),
  );
  if (
    run.workflowName !== "Package" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new Error(`Run ${runId} is not a successful Package workflow.`);
  const directory = join(root, "artifacts", "packages", "cloud", runId);
  await mkdir(directory, { recursive: true });
  execFileSync(
    "gh",
    [
      "run",
      "download",
      runId,
      "--repo",
      repository,
      "--pattern",
      "package-*",
      "--dir",
      directory,
    ],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  for (const name of Object.keys(targets))
    await verifyPackage(join(directory, `package-${name}`), name);
  return directory;
}

/** 提供矩阵、构建、收集和 GitHub CLI 操作的统一命令行入口。 */
async function main() {
  const [command, value] = process.argv.slice(2);
  if (command === "matrix")
    console.log(`matrix=${JSON.stringify(packageMatrix())}`);
  else if (command === "local-platform") console.log(localPlatform());
  else if (command === "package-local")
    console.log(await packageHere(localPlatform()));
  else if (command === "package" && value)
    console.log(await packageHere(value));
  else if (command === "build" && value) await buildPackage(value);
  else if (command === "collect" && value)
    console.log(await collectPackage(value));
  else if (command === "dispatch") dispatchPackage(value);
  else if (command === "download") console.log(await downloadPackage(value));
  else
    throw new Error(
      "Usage: package.mjs matrix|local-platform|package-local|package <platform>|build <platform>|collect <platform>|dispatch [branch]|download <run-id>",
    );
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
