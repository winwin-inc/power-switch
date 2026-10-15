import { beforeEach, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import capability from "../../src-tauri/capabilities/default.json";
import { openAboutLink, releaseNotesUrl, repositoryUrl } from "../about-api";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it.each(["0.1.9", "0.1.10", "0.2.0-rc.1"])(
  "links to the exact installed release %s",
  (version) => {
    expect(releaseNotesUrl(version)).toBe(
      `https://github.com/winwin-inc/power-switch/releases/tag/v${version}`,
    );
  },
);

it("opens both project destinations using the scoped desktop command", async () => {
  await openAboutLink("github");
  expect(invoke).toHaveBeenLastCalledWith("plugin:opener|open_url", {
    url: repositoryUrl,
  });
  await openAboutLink("changelog");
  expect(invoke).toHaveBeenLastCalledWith("plugin:opener|open_url", {
    url: `https://github.com/winwin-inc/power-switch/releases/tag/v${packageJson.version}`,
  });
  const scope = capability.permissions.find(
    (entry) =>
      typeof entry === "object" && entry.identifier === "opener:allow-open-url",
  );
  expect(scope).toBeDefined();
  if (typeof scope !== "object") throw new Error("Missing opener scope");
  expect(
    scope.allow.filter((entry) => entry.url.includes("github.com")),
  ).toEqual([
    { url: repositoryUrl },
    { url: `${repositoryUrl}/releases/tag/v*` },
  ]);
});
