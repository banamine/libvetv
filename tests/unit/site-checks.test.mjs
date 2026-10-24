import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./network-guard.mjs";
import { checkAdditive } from "../../scripts/check-additive.mjs";
import { verifySite, checkAddedResourceOrigins } from "../../scripts/verify-site.mjs";
import { setTextContent } from "../../assets/daily-playlist.js";

const BASE_URL = "https://example.invalid/libvetv/";

test("additive check accepts an already-featured base but still rejects preserved-page edits", () => {
  const page = "<html>\n<!-- DAILY-PLAYLIST:BEGIN -->\n<div id=\"dp-open\"></div>\n<!-- DAILY-PLAYLIST:END -->\n</html>\n";
  assert.equal(checkAdditive({ baseBytes: Buffer.from(page), currentBytes: Buffer.from(page), numstat: "" }).markerBlocks, 1);
  assert.throws(() => checkAdditive({
    baseBytes: Buffer.from(page), currentBytes: Buffer.from(page.replace("<html>", "<html lang=\"en\">")), numstat: "",
  }), /index_html_base_mismatch/);
});

async function makeSite(t) {
  const root = await mkdtemp(join(tmpdir(), "libvetv-site-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html>\n");
  await writeFile(join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {} },
  }));
  return root;
}

async function writePublishedManifest(root, {
  row = {
    id: "demo-channel",
    label: "Demo channel",
    guideId: "demo-guide",
    status: "ok",
    reason: null,
    manifest: "latest/demo-channel.json",
    itemCount: 1,
    declaredTotalSeconds: null,
    durationBasis: "unknown",
    publishedAt: "2026-10-24T10:00:00.000Z",
  },
  manifest = {
    schemaVersion: 1,
    channelId: "demo-channel",
    items: [{
      seq: 1,
      localId: "lv-0123456789ab",
      title: "Synthetic item",
      url: "https://archive.org/download/demo/item.mp4",
      durationSec: null,
    }],
  },
} = {}) {
  await mkdir(join(root, "daily/latest"), { recursive: true });
  await writeFile(
    join(root, "daily/latest/index.json"),
    `${JSON.stringify({ schemaVersion: 1, channels: [row] }, null, 2)}\n`,
  );
  if (row.manifest) {
    await writeFile(
      join(root, "daily", row.manifest),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
}

test("verify-site accepts a repository with no daily index", async (t) => {
  const root = await makeSite(t);
  const result = await verifySite({ root, resourceDiff: "" });
  assert.deepEqual(result, {
    published: false,
    checkedManifests: 0,
    message: "No daily/latest/index.json; valid (nothing has been published).",
  });
});

test("verify-site rejects lockfiles that resolve packages through a non-public registry", async (t) => {
  const root = await makeSite(t);
  await writeFile(join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/example": {
        resolved: "http://package-firewall.replit.internal/npm/example/-/example-1.0.0.tgz",
      },
    },
  }));
  await assert.rejects(
    verifySite({ root, resourceDiff: "" }),
    /lockfile_resolved_url_invalid/,
  );
});

test("verify-site validates a public index and its referenced manifest", async (t) => {
  const root = await makeSite(t);
  await writePublishedManifest(root);
  const result = await verifySite({ root, resourceDiff: "" });
  assert.deepEqual(result, {
    published: true,
    checkedManifests: 1,
    message: "PASS: index and referenced manifests validated.",
  });
  assert.equal(BASE_URL, "https://example.invalid/libvetv/");
});

test("verify-site rejects an index that references a missing manifest", async (t) => {
  const root = await makeSite(t);
  await writePublishedManifest(root, {
    row: {
      id: "demo-channel",
      label: "Demo channel",
      guideId: "demo-guide",
      status: "ok",
      reason: null,
      manifest: "latest/demo-channel.json",
      itemCount: 1,
      declaredTotalSeconds: null,
      durationBasis: "unknown",
      publishedAt: null,
    },
  });
  await rm(join(root, "daily/latest/demo-channel.json"));
  await assert.rejects(
    verifySite({ root, resourceDiff: "" }),
    /manifest_file_missing/,
  );
});

test("verify-site rejects unsafe media URLs in referenced manifests", async (t) => {
  const root = await makeSite(t);
  await writePublishedManifest(root, {
    manifest: {
      schemaVersion: 1,
      channelId: "demo-channel",
      items: [{
        seq: 1,
        localId: "lv-0123456789ab",
        title: "Synthetic item",
        url: "../outside.mp4",
        durationSec: null,
      }],
    },
  });
  await assert.rejects(
    verifySite({ root, resourceDiff: "" }),
    /manifest_item_invalid/,
  );
});

test("verify-site rejects assets modules that import from scripts", async (t) => {
  const root = await makeSite(t);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(
    join(root, "assets/daily-playlist.js"),
    'import { eligibility } from "../scripts/lib/eligibility.mjs";\n',
  );
  await assert.rejects(
    verifySite({ root, resourceDiff: "" }),
    /assets_import_scripts/,
  );
});

test("browser import graph stays on .js assets with a one-line Node re-export", async () => {
  const browserSource = await readFile(
    new URL("../../assets/daily-playlist.js", import.meta.url),
    "utf8",
  );
  const browserValidator = await readFile(
    new URL("../../assets/eligibility.js", import.meta.url),
    "utf8",
  );
  const nodeFacade = await readFile(
    new URL("../../scripts/lib/eligibility.mjs", import.meta.url),
    "utf8",
  );
  assert.match(browserSource, /from "\.\/eligibility\.js"/);
  assert.doesNotMatch(browserSource, /from ["'][^"']*\.mjs["']/);
  assert.doesNotMatch(browserSource, /from ["'](?:node:|\.{1,2}\/scripts\/)/);
  assert.doesNotMatch(browserValidator, /\bimport\b/);
  assert.equal(
    nodeFacade.trim(),
    'export { eligibility, normalizeTitle } from "../../assets/eligibility.js";',
  );
});

test("verify-site accepts same-origin new resources and rejects off-origin ones", () => {
  assert.equal(
    checkAddedResourceOrigins(
      '+<link rel="stylesheet" href="assets/daily-playlist.css">\n+<script src="./assets/daily-playlist.js"></script>',
    ),
    true,
  );
  assert.throws(
    () => checkAddedResourceOrigins('+<script src="https://evil.example/x.js"></script>'),
    /new_resource_off_origin/,
  );
  assert.throws(
    () => checkAddedResourceOrigins('+<script\n+  src="https://evil.example/x.js"\n+></script>'),
    /new_resource_off_origin/,
  );
});

test("check-additive accepts marker-only insertions and rejects deletions or altered base bytes", () => {
  const base = Buffer.from("<html>\n</html>\n");
  const current = Buffer.from(
    "<html>\n<!-- DAILY-PLAYLIST:BEGIN -->\n<link href=\"assets/a.css\">\n<!-- DAILY-PLAYLIST:END -->\n</html>\n",
  );
  assert.deepEqual(checkAdditive({
    baseBytes: base,
    currentBytes: current,
    numstat: "3\t0\tindex.html",
  }), {
    deletedLines: 0,
    markerBlocks: 1,
    baseHash: "5a2ac931301d8e2c0e118db5387e5ab02472fc16b3a2fe1759e6932cdf5bb841",
  });
  assert.throws(
    () => checkAdditive({ baseBytes: base, currentBytes: current, numstat: "1\t3\tindex.html" }),
    /index_html_deletions_detected/,
  );
  assert.throws(
    () => checkAdditive({
      baseBytes: base,
      currentBytes: Buffer.from(current.toString().replace("</html>", "<!-- changed --></html>")),
      numstat: "4\t0\tindex.html",
    }),
    /index_html_base_mismatch/,
  );
});

test("check-additive rejects unmatched markers and more than three blocks", () => {
  const base = Buffer.from("base\n");
  assert.throws(
    () => checkAdditive({
      baseBytes: base,
      currentBytes: Buffer.from(`${base}<!-- DAILY-PLAYLIST:BEGIN -->`),
      numstat: "1\t0\tindex.html",
    }),
    /marker_blocks_invalid/,
  );
  const threeBlocks = Array.from({ length: 4 }, () =>
    "<!-- DAILY-PLAYLIST:BEGIN -->\n<!-- DAILY-PLAYLIST:END -->\n",
  ).join("");
  assert.throws(
    () => checkAdditive({
      baseBytes: base,
      currentBytes: Buffer.from(`${base}${threeBlocks}`),
      numstat: "8\t0\tindex.html",
    }),
    /marker_blocks_invalid/,
  );
});

test("feed titles are assigned with textContent and never parsed as markup", async () => {
  const element = { textContent: "", innerHTML: "unchanged" };
  const payload = '<img src=x onerror=alert(1)>';
  setTextContent(element, payload);
  assert.equal(element.textContent, payload);
  assert.equal(element.innerHTML, "unchanged");
  const source = await readFile(
    new URL("../../assets/daily-playlist.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\.innerHTML\b/);
});
