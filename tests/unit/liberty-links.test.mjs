import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import "./network-guard.mjs";

const data = JSON.parse(await readFile(new URL("../../data/liberty-links.json", import.meta.url), "utf8"));
const CATEGORIES = ["Live TV", "News", "Movies", "Series", "Radio", "General"];

test("liberty-links.json has the expected shape and only liberty-express.org pages", () => {
  assert.equal(data.schemaVersion, 1);
  assert.match(data.source, /^banamine\/Control-Nav-Page index\.html @ [0-9a-f]{40}$/);
  assert.ok(Array.isArray(data.pages) && data.pages.length >= 300);
  const seen = new Set();
  for (const page of data.pages) {
    assert.equal(typeof page.title, "string");
    assert.ok(page.title.trim().length > 0);
    assert.ok(CATEGORIES.includes(page.cat), `bad category ${page.cat}`);
    const url = new URL(page.url);
    assert.equal(url.origin, "https://www.liberty-express.org");
    assert.ok(url.pathname === "/" || url.pathname.endsWith(".html"), page.url);
    assert.ok(!seen.has(page.url), `duplicate ${page.url}`);
    seen.add(page.url);
  }
});
