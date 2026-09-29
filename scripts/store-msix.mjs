import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersion, targets, versionFromTag } from "./release.mjs";

const platforms = {
  "windows-x64": "x64",
  "windows-arm64": "arm64",
};
const icons = ["StoreLogo", "Square150x150Logo", "Square44x44Logo"];

/** Map a stable app version to a monotonic Store version with a nonzero major and reserved final zero. */
export function storeVersion(tag) {
  const version = versionFromTag(tag);
  if (version.includes("-") || version.includes("+"))
    throw new Error("Microsoft Store packages require a stable version tag");
  const parts = version.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error("Microsoft Store version contains an unsafe integer");
  if (parts[0] > 65534 || parts.slice(1).some((part) => part > 65535))
    throw new Error("Microsoft Store version component exceeds 65535");
  return `${parts[0] + 1}.${parts[1]}.${parts[2]}.0`;
}

/** Require the exact reserved Store identity rather than silently packaging placeholder values. */
export function storeIdentity(environment) {
  const fields = {
    name: environment.STORE_PACKAGE_NAME?.trim(),
    publisher: environment.STORE_PUBLISHER?.trim(),
    publisherDisplayName: environment.STORE_PUBLISHER_DISPLAY_NAME?.trim(),
    displayName: environment.STORE_DISPLAY_NAME?.trim(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))
      throw new Error(
        `Missing or invalid Microsoft Store identity field: ${key}`,
      );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(fields.name))
    throw new Error("Microsoft Store package name contains invalid characters");
  if (!fields.publisher.startsWith("CN="))
    throw new Error(
      "Microsoft Store publisher must be the Partner Center CN= identity",
    );
  return fields;
}

/** Escape Partner Center values before inserting them into the MSIX XML manifest. */
function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;");
}

/** Build a packaged classic desktop manifest with full-trust access and the existing deep link. */
export function storeManifest(tag, platform, identity) {
  const architecture = platforms[platform];
  if (!architecture) throw new Error(`Unsupported Store platform: ${platform}`);
  const version = storeVersion(tag);
  const { name, publisher, publisherDisplayName, displayName } = storeIdentity({
    STORE_PACKAGE_NAME: identity.name,
    STORE_PUBLISHER: identity.publisher,
    STORE_PUBLISHER_DISPLAY_NAME: identity.publisherDisplayName,
    STORE_DISPLAY_NAME: identity.displayName,
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">
  <Identity Name="${xml(name)}" Publisher="${xml(publisher)}" Version="${version}" ProcessorArchitecture="${architecture}" />
  <Properties>
    <DisplayName>${xml(displayName)}</DisplayName>
    <PublisherDisplayName>${xml(publisherDisplayName)}</PublisherDisplayName>
    <Description>AI model configuration manager</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources><Resource Language="zh-cn" /></Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
  <Applications>
    <Application Id="PowerSwitch" Executable="power-switch.exe"
                 uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="${xml(displayName)}" Description="AI model configuration manager"
                          Square150x150Logo="Assets\\Square150x150Logo.png"
                          Square44x44Logo="Assets\\Square44x44Logo.png" BackgroundColor="transparent" />
      <Extensions>
        <uap:Extension Category="windows.protocol"><uap:Protocol Name="power-switch" /></uap:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
`;
}

/** Locate the Windows SDK packaging tool on both x64 and ARM64 hosted runners. */
async function makeAppxPath(environment) {
  if (environment.MAKEAPPX_PATH) {
    await access(environment.MAKEAPPX_PATH, constants.X_OK);
    return environment.MAKEAPPX_PATH;
  }
  const sdk = join(
    environment["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Windows Kits",
    "10",
    "bin",
  );
  const versions = (await readdir(sdk, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    );
  for (const version of versions) {
    for (const arch of process.arch === "arm64" ? ["arm64", "x64"] : ["x64"]) {
      const candidate = join(sdk, version, arch, "makeappx.exe");
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // An SDK version can omit the host architecture; try the next tool.
      }
    }
  }
  throw new Error("Windows SDK MakeAppx.exe was not found");
}

/** Stage the desktop executable and Store icons, then create an unsigned MSIX for Store signing. */
export async function packStoreMsix(
  root,
  tag,
  platform,
  identity,
  environment,
) {
  if (process.platform !== "win32")
    throw new Error("MSIX packaging must run on Windows");
  if (!platforms[platform])
    throw new Error(`Unsupported Store platform: ${platform}`);
  await checkVersion(root, tag);
  const manifest = storeManifest(tag, platform, identity);
  const executable = join(
    root,
    "src-tauri",
    "target",
    targets[platform].triple,
    "release",
    "power-switch.exe",
  );
  await access(executable, constants.R_OK);
  const stage = await mkdtemp(join(tmpdir(), "power-switch-msix-"));
  const outputDir = join(root, "store-assets");
  const output = join(
    outputDir,
    `power-switch-${tag}-${platform}-store-unsigned.msix`,
  );
  try {
    await mkdir(join(stage, "Assets"), { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await copyFile(executable, join(stage, "power-switch.exe"));
    for (const icon of icons)
      await copyFile(
        join(root, "src-tauri", "icons", `${icon}.png`),
        join(stage, "Assets", `${icon}.png`),
      );
    await writeFile(join(stage, "AppxManifest.xml"), manifest);
    const makeappx = await makeAppxPath(environment);
    execFileSync(
      makeappx,
      ["pack", "/v", "/h", "SHA256", "/d", stage, "/p", output, "/no"],
      { stdio: "inherit" },
    );
    await access(output, constants.R_OK);
    return output;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Validate Partner Center identity before expensive Windows builds, or package a checked tag. */
async function main() {
  const [command, tag, platform] = process.argv.slice(2);
  const root = resolve(
    process.env.RELEASE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)),
  );
  const identity = storeIdentity(process.env);
  await checkVersion(root, tag);
  storeVersion(tag);
  if (command === "check") {
    console.log(`Store identity and version validated: ${tag}`);
    return;
  }
  if (command !== "pack" || !platform)
    throw new Error(
      "Usage: store-msix.mjs check|pack v<stable-version> [windows-x64|windows-arm64]",
    );
  const output = await packStoreMsix(
    root,
    tag,
    platform,
    identity,
    process.env,
  );
  console.log(`Store MSIX created: ${output}`);
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
