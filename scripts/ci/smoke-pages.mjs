import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eligibility } from "../../assets/eligibility.js";
import { resolveManifestUrl } from "../../assets/manifest-path.js";

export async function smokePages(pageUrl, fetchImpl = globalThis.fetch) {
  const base = new URL(pageUrl);
  if (base.protocol !== "https:" || base.username || base.password) throw new Error("page_url_invalid");
  async function fetchJson(url) {
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (response.status !== 200) throw new Error("page_json_http_error");
    return response.json();
  }
  const index = await fetchJson(new URL("./daily/latest/index.json", base).href);
  if (index?.schemaVersion !== 1 || !Array.isArray(index.channels) || index.channels.length === 0) {
    throw new Error("page_index_invalid");
  }
  let count = 0;
  for (const row of index.channels) {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(row.id || "") ||
        !["ok", "error", "no_playlist"].includes(row.status)) throw new Error("page_row_invalid");
    if (row.manifest === null && row.status !== "ok") continue;
    const url = resolveManifestUrl(row.manifest, row.id, base.href);
    const manifest = await fetchJson(url);
    if (manifest?.schemaVersion !== 1 || manifest.channelId !== row.id ||
        !Array.isArray(manifest.items) || manifest.items.length === 0 ||
        manifest.items.some((item, i) => item.seq !== i + 1 ||
          typeof item.localId !== "string" || typeof item.title !== "string" ||
          !eligibility({ url: item.url, durationSec: item.durationSec ?? -1 }).ok)) {
      throw new Error("page_manifest_invalid");
    }
    count += 1;
  }
  return { checkedManifests: count };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokePages(process.env.PAGE_URL).then((result) => {
    console.log(`PASS: checked_manifests=${result.checkedManifests}`);
  }).catch(() => { console.error("pages_smoke_failed"); process.exitCode = 1; });
}
