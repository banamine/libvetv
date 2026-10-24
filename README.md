# libvetv Daily Playlist

## Architecture

- This adds an on-demand, sequential playlist mode to the existing LIVE / 24h Schedule page.
- Playback is direct Archive.org MP4 only; it is not a live stream.
- The feature uses no embeds and accepts no audio-only entries.
- The generator reads one AJN channel M3U endpoint for each enabled channel.
- It validates and writes JSON/M3U manifests only when their content changes.
- GitHub Actions publishes only allowlisted `daily/` paths when publishing is enabled.
- GitHub Pages serves the repository-root artifact; the existing page loads daily data only after the user opens the panel.
- The existing schedule and live-player experience remains separate and unchanged.

## Channels and configuration

`config/channels.json` is the source of truth for channel configuration. Each channel has an `id`, `guideId`, display `label`, and `enabled` flag. The file also defines the 86,400-second target, tolerance, maximum source age, and allowed future clock skew. At most eight channels are supported; IDs and guide IDs must follow the lowercase slug formats validated by the generator.

To add a channel, add a unique row to `channels`, using the channel ID and guide ID from AJN. Keep the label descriptive, set `enabled` deliberately, then run the offline unit tests and site checks. The generator validates the full configuration before any source request. The source endpoint is `/api/channels/{channelId}/playlist.m3u?guide={guideId}`.

## Data flow

```text
config/channels.json
        |
        v
daily-playlist workflow: gate -> Node 22 -> generate from AJN M3U
        |
        v
parse -> validate source freshness and media URLs -> select ordered items
        |
        v
.tmp/out/daily/ + changed-files.txt (only changed content)
        |
        v
publish job validates allowlist -> commits listed daily/ files to main
        |
        v
deploy job uploads the repository root -> GitHub Pages
        |
        v
existing page, after panel opens: index -> manifest -> user-started MP4 sequence
```

The workflow gate runs before generation. Scheduled runs stay gated while publishing is disabled, and a missing `AJN_EXPORT_BASE_URL` stops generation before a request. A manual `dry_run=true` run is allowed to fetch the source and is the first-run review path; it does not publish.

## Generated data and manifest

The published index is `daily/latest/index.json` (schema version 1). It records each channel's ID, label, guide ID, status, reason code, latest manifest path, item count, declared duration total/basis, and publication timestamp. A channel with a last-good manifest can keep pointing at it while its current status reports a failed refresh.

Each `daily/latest/<id>.json` manifest has schema version 1 and `playbackMode: "sequential"`. It includes channel and guide identity, service day, source-generated and first-published timestamps, content hash, target/tolerance, duration basis and declared total, item/unique/repeat counts, exclusion reason counts, the local-ID note, and ordered items (`seq`, `localId`, `title`, URL, and nullable `durationSec`). The paired M3U is `daily/latest/<id>.m3u`; dated copies are under `daily/YYYY-MM-DD/<id>/`.

Unchanged content is represented by writing nothing: no new dated files and no timestamp churn. `sourceGeneratedAt` and `publishedAt` therefore describe when this exact content was first published, not the most recent check.

## Duration policy

Durations are **declared**, not verified playback times. When every eligible item has a known duration, the generator chooses a complete source-order prefix closest to 86,400 seconds within the configured tolerance. It never truncates an item. If any eligible item's duration is unknown, the playlist may still be published, but its duration basis is `unknown`, its declared total is `null`, and the UI must make no 24-hour claim. Repeated media URLs are removed upstream by the AJN serializer; this source cannot preserve scheduled repeat slots.

## Local checks

Use Node 22 and install the locked dependencies:

```sh
npm ci
npm run test:unit
npx playwright install chromium
npm run test:browser
npm run verify:site
npm run check:additive -- --base origin/main
```

Unit and browser checks use local fixtures; they do not contact AJN or Archive.org. `verify:site` accepts a repository with no published daily index. `check:additive` proves the existing page's non-feature bytes still match the base branch.

For an offline fixture generation run:

```sh
node scripts/generate.mjs --baseline-dir . --out .tmp/out --fixture-dir tests/fixtures --now 2026-10-24T12:00:00Z
```

The fixture mode makes no network request. A normal generator run requires the owner-provided source URL and must follow the first-run review sequence below.

## Owner switches and first-run order

The three owner-controlled switches are:

1. `AJN_EXPORT_BASE_URL` repository variable: the public HTTPS AJN base origin.
2. `PUBLISH_ENABLED` repository variable: set to the exact string `true` only to permit publication.
3. `dry_run` workflow-dispatch input: defaults to `true`; `true` permits source retrieval and artifact review but prevents publishing.

First-run order:

1. Set `AJN_EXPORT_BASE_URL`; leave `PUBLISH_ENABLED` unset or disabled.
2. Manually run `daily-playlist` with `dry_run=true`. **This makes the first real AJN request.** A dry run is not network-free.
3. Review the generated artifact, channel states, manifests, and playlist files.
4. Complete the separate rights review. Only after approval, set `PUBLISH_ENABLED=true`.

Manual `dry_run=false` while publishing is disabled remains non-publishing. The scheduled workflow exits successfully before contacting AJN when publishing is disabled. Never place these values in source files or logs.

## Rights and known limits

- Rights are unverified and require a separate owner decision; AJN's M3U contains no rights data.
- The M3U has no rights data and no canonical AJN item IDs.
- Declared durations are not verified playback times.
- Some Archive items may not play; failures are shown as visible player errors.
- The source removes repeated URLs upstream; slot-preserving repeats require an upstream change.
- AJN's endpoint may trigger its own refresh when its 10-minute cache is cold.
- The Cloud Run production URL is NOT verified reachable from GitHub runners.
- This feature is for archived episodes only, not live news.
- The existing page loads `hls.js@latest` unpinned from jsdelivr; that is pre-existing and untouched.
- GitHub Pages publishes the repository as `static.yml` does; `tests/`, `scripts/`, and `package.json` are publicly served.

## Retention, deployment, and rollback

Dated snapshots under `daily/YYYY-MM-DD/<id>/` are kept indefinitely in v1: one JSON and one M3U per **changed** channel. There is no automatic pruning. Prune old dated folders manually in a normal PR; the workflow status summary reports the total `daily/` size so growth is visible.

A publish push rejected because another commit reached `main` is handled by re-running the workflow after the branch is current. Do not hand-edit generated files under `daily/`.

Rollback is to revert the feature PR; there is no pre-wipe tag. Before enabling a `main` branch-protection rule that requires PRs, read the [branch-protection caution](docs/ENGINEERING_PRACTICES.md#branch-protection-caution): the rule can block the Actions bot's direct generated-data push unless that bot is allowed to bypass it.

**Deployment prerequisite:** use GitHub Actions as the Pages source for artifact-based deployment rather than the legacy branch/Jekyll build. No Pages setting is changed by this feature.

## Engineering practices

Browser code under `assets/` must never import from `scripts/`. The canonical repository rules, including security, testing, permissions, and workflow conventions, are in [docs/ENGINEERING_PRACTICES.md](docs/ENGINEERING_PRACTICES.md). Follow that document instead of maintaining a duplicate rule list here.
