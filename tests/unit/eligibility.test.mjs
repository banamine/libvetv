import test from "node:test";
import assert from "node:assert/strict";
import "./network-guard.mjs";
import { eligibility, normalizeTitle } from "../../scripts/lib/eligibility.mjs";

const item = (url, durationSec = 10, title = "Title") => ({ url, durationSec, title });
const acceptedUrl = "https://archive.org/download/item/video.mp4";

test("accepts only direct HTTPS Archive.org MP4 downloads", () => {
  assert.deepEqual(eligibility(item(acceptedUrl)), { ok: true, kind: "video" });
  assert.deepEqual(eligibility(item("https://ARCHIVE.ORG/download/item/video.MP4")), {
    ok: true,
    kind: "video",
  });
});

test("rejects relative URLs before URL parsing", () => {
  for (const url of ["/api/archive/proxy?x=1", "//x.com/a.mp4", "./a.mp4", "../a.mp4", "a.mp4"]) {
    assert.deepEqual(eligibility(item(url)), { ok: false, reason: "relative_url" });
  }
});

test("rejects invalid URL strings", () => {
  assert.deepEqual(eligibility(item("https://%")), { ok: false, reason: "bad_url" });
  assert.deepEqual(eligibility({ durationSec: 10 }), { ok: false, reason: "bad_url" });
});

test("rejects HTTP and non-Archive hosts", () => {
  assert.equal(eligibility(item("http://archive.org/download/a/a.mp4")).reason, "not_https");
  assert.equal(eligibility(item("https://archive.org.evil.example/download/a/a.mp4")).reason, "host_not_archive");
  assert.equal(eligibility(item("https://ia800000.us.archive.org/download/a/a.mp4")).reason, "host_not_archive");
  assert.equal(eligibility(item("https://archive.org:8443/download/a/a.mp4")).reason, "host_not_archive");
});

test("requires the Archive download path and an MP4 extension", () => {
  assert.equal(eligibility(item("https://archive.org/details/item/video.mp4")).reason, "not_download_path");
  assert.equal(eligibility(item("https://archive.org/download/item/video.m3u8")).reason, "not_mp4");
});

test("rejects credentials, query strings, and hashes", () => {
  assert.equal(eligibility(item("https://user:pass@archive.org/download/a/a.mp4")).reason, "has_credentials");
  assert.equal(eligibility(item(`${acceptedUrl}?download=1`)).reason, "has_query");
  assert.equal(eligibility(item(`${acceptedUrl}#fragment`)).reason, "has_query");
});

test("checks URL controls and length before URL parsing", () => {
  assert.equal(eligibility(item("https://archive.org/download/a/\u0000.mp4")).reason, "control_chars");
  const longUrl = `https://archive.org/download/${"a".repeat(2049)}.mp4`;
  assert.equal(eligibility(item(longUrl)).reason, "too_long");
});

test("accepts unknown duration but rejects invalid known durations", () => {
  assert.deepEqual(eligibility(item(acceptedUrl, -1)), { ok: true, kind: "video" });
  for (const durationSec of [0, -2, 1.5, "abc", undefined]) {
    assert.equal(eligibility({ url: acceptedUrl, durationSec }).reason, "bad_duration");
  }
});

test("normalizes titles without interpreting markup", () => {
  assert.equal(normalizeTitle("  A\n\t B\u0000 <img src=x>  "), "A B <img src=x>");
  assert.equal(normalizeTitle(" \u0000 \n "), "Untitled");
  assert.equal(normalizeTitle("x".repeat(205)).length, 200);
  assert.equal(normalizeTitle(null), "Untitled");
});

test("excluded entries can be counted by reason without losing the reason code", () => {
  const candidates = [
    item("/api/archive/proxy?x=1"),
    item("http://archive.org/download/a/a.mp4"),
    item(acceptedUrl, 0),
    item(acceptedUrl),
  ];
  const counts = {};
  for (const candidate of candidates) {
    const result = eligibility(candidate);
    if (!result.ok) counts[result.reason] = (counts[result.reason] || 0) + 1;
  }
  assert.deepEqual(counts, { relative_url: 1, not_https: 1, bad_duration: 1 });
});
