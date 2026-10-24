import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicRegistryLockfile } from "../../scripts/check-lockfile.mjs";

test("lockfile accepts public npm registry URLs and entries without resolved URLs", () => {
  assert.equal(assertPublicRegistryLockfile({
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/example": {
        resolved: "https://registry.npmjs.org/example/-/example-1.2.3.tgz",
      },
      "node_modules/local": { version: "1.0.0" },
    },
  }), true);
});

test("lockfile rejects internal, HTTP, and non-npm registry URLs", () => {
  for (const resolved of [
    "http://package-firewall.replit.internal/npm/example/-/example-1.2.3.tgz",
    "http://registry.npmjs.org/example/-/example-1.2.3.tgz",
    "https://registry.other.example/example/-/example-1.2.3.tgz",
  ]) {
    assert.throws(
      () => assertPublicRegistryLockfile({
        lockfileVersion: 3,
        packages: { "node_modules/example": { resolved } },
      }),
      /lockfile_resolved_url_invalid/,
    );
  }
});

test("lockfile checker rejects missing package maps", () => {
  assert.throws(
    () => assertPublicRegistryLockfile({ lockfileVersion: 3 }),
    /lockfile_packages_invalid/,
  );
});
