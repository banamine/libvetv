import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "./network-guard.mjs";
import { M3uParseError, parseM3u } from "../../scripts/lib/parseM3u.mjs";

const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

test("parses the owner-provided classic-cinema sample and preserves titles and URLs", async () => {
  const text = await readFile(fixture("movies-classics-vault__classic-cinema.m3u"), "utf8");
  const items = parseM3u(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].durationSec, -1);
  assert.equal(items[0].attributes["tvg-id"], "classic-cinema");
  assert.equal(items[0].title, "Cinema Classics Vault - TheDeathKiss");
  assert.equal(items[0].url, "https://archive.org/download/TheDeathKiss/DeathKiss_512kb.mp4");
  assert.equal(items[1].title, "Cinema Classics Vault - Walk a Crooked Mile (1948)");
});

test("parses the synthetic eight-item duration fixture without network access", async () => {
  const text = await readFile(fixture("cable-tv__ajn-infowars-nightly-news.m3u"), "utf8");
  const items = parseM3u(text);
  assert.equal(items.length, 8);
  assert.deepEqual(items.map((item) => item.durationSec), [
    12614, 7218, 12642, 11132, 10831, 7217, 11144, 14334,
  ]);
  assert.ok(items.every((item) => item.attributes["tvg-id"] === "ajn-infowars-nightly-news"));
});

test("accepts commas in quoted attributes and leaves commas in the title intact", () => {
  const [item] = parseM3u(
    '#EXTM3U\n#EXTINF:42 tvg-name="A, B" group-title="News, World",Title, with comma\nhttps://archive.org/download/id/file.mp4',
  );
  assert.equal(item.attributes["tvg-name"], "A, B");
  assert.equal(item.attributes["group-title"], "News, World");
  assert.equal(item.title, "Title, with comma");
});

test("ignores non-EXTM3U comments between entries", () => {
  const items = parseM3u(
    "#EXTM3U\n# AJN guide comment · UTF-8\n#EXTINF:12 tvg-id=\"a\",One\nhttps://archive.org/download/a/one.mp4\n",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "One");
});

test("accepts CRLF line endings and a UTF-8 BOM", () => {
  const items = parseM3u(
    '\uFEFF#EXTM3U\r\n#EXTINF:12 tvg-id="a",One\r\nhttps://archive.org/download/a/one.mp4\r\n',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].durationSec, 12);
});

test("empty input and a header without entries have the empty code", () => {
  for (const input of ["", " \n\t", "#EXTM3U\n# comment\n"]) {
    assert.throws(() => parseM3u(input), (error) =>
      error instanceof M3uParseError && error.code === "empty",
    );
  }
});

test("requires #EXTM3U as the first non-empty line", () => {
  assert.throws(
    () => parseM3u("# comment first\n#EXTM3U\n#EXTINF:1,One\nhttps://archive.org/download/a/a.mp4"),
    (error) => error.code === "malformed",
  );
  assert.throws(
    () => parseM3u("#EXTINF:1,One\nhttps://archive.org/download/a/a.mp4"),
    (error) => error.code === "malformed",
  );
});

test("rejects EXTINF without a URL, including a second EXTINF", () => {
  for (const input of [
    "#EXTM3U\n#EXTINF:1,One\n",
    "#EXTM3U\n#EXTINF:1,One\n#EXTINF:2,Two\nhttps://archive.org/download/a/a.mp4",
  ]) {
    assert.throws(() => parseM3u(input), (error) => error.code === "malformed");
  }
});

test("rejects a URL without a preceding EXTINF", () => {
  assert.throws(
    () => parseM3u("#EXTM3U\nhttps://archive.org/download/a/a.mp4"),
    (error) => error.code === "malformed",
  );
});

test("rejects malformed attributes and unterminated quotes", () => {
  for (const line of [
    '#EXTINF:1 tvg-id=a,One',
    '#EXTINF:1 tvg-id="a"bad="b",One',
    '#EXTINF:1 tvg-id="a,One',
  ]) {
    assert.throws(
      () => parseM3u(`#EXTM3U\n${line}\nhttps://archive.org/download/a/a.mp4`),
      (error) => error.code === "malformed",
    );
  }
});

test("rejects non-integer and unsafe EXTINF durations", () => {
  for (const duration of ["abc", "1.5", "9007199254740992"]) {
    assert.throws(
      () => parseM3u(`#EXTM3U\n#EXTINF:${duration},One\nhttps://archive.org/download/a/a.mp4`),
      (error) => error.code === "malformed",
    );
  }
});
