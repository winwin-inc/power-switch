import assert from "node:assert/strict";
import test from "node:test";
import { storeIdentity, storeManifest, storeVersion } from "./store-msix.mjs";

const identity = {
  name: "Example.PowerSwitch",
  publisher: "CN=Example & Company",
  publisherDisplayName: "Example & Company",
  displayName: "Power Switch <Desktop>",
};

/** Check that the Store version never has a zero major or a nonzero reserved revision. */
test("maps stable SemVer tags to monotonic Store package versions", () => {
  assert.equal(storeVersion("v0.1.6"), "1.1.6.0");
  assert.equal(storeVersion("v1.0.0"), "2.0.0.0");
  assert.throws(() => storeVersion("v0.1.6-rc.4"), /stable/);
  assert.throws(() => storeVersion("v0.1.6+build.1"), /stable/);
  assert.throws(() => storeVersion("v65535.0.0"), /exceeds/);
});

/** Reject absent or placeholder identity before a costly Windows build can start. */
test("requires the reserved Partner Center identity", () => {
  assert.deepEqual(
    storeIdentity({
      STORE_PACKAGE_NAME: identity.name,
      STORE_PUBLISHER: identity.publisher,
      STORE_PUBLISHER_DISPLAY_NAME: identity.publisherDisplayName,
      STORE_DISPLAY_NAME: identity.displayName,
    }),
    identity,
  );
  assert.throws(() => storeIdentity({}), /name/);
  assert.throws(
    () =>
      storeIdentity({
        STORE_PACKAGE_NAME: "Example/Bad",
        STORE_PUBLISHER: identity.publisher,
        STORE_PUBLISHER_DISPLAY_NAME: identity.publisherDisplayName,
        STORE_DISPLAY_NAME: identity.displayName,
      }),
    /invalid characters/,
  );
});

/** Protect XML integrity and preserve packaged desktop and import-link capabilities. */
test("generates an escaped full-trust MSIX manifest for each architecture", () => {
  const x64 = storeManifest("v0.1.6", "windows-x64", identity);
  const arm64 = storeManifest("v0.1.6", "windows-arm64", identity);
  assert.match(x64, /ProcessorArchitecture="x64"/);
  assert.match(arm64, /ProcessorArchitecture="arm64"/);
  assert.match(x64, /Version="1\.1\.6\.0"/);
  assert.match(x64, /Publisher="CN=Example &amp; Company"/);
  assert.match(x64, /DisplayName>Power Switch &lt;Desktop&gt;</);
  assert.match(x64, /runFullTrust/);
  assert.match(x64, /windows\.protocol/);
  assert.match(x64, /Protocol Name="power-switch"/);
  assert.throws(
    () => storeManifest("v0.1.6", "linux-x64", identity),
    /Unsupported Store platform/,
  );
});
