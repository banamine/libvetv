# libvetv engineering practices

Status: adopted 2026-10-24. This is the standing rule set for the Daily Playlist work and anything built after it. Pages publishes this repository as-is, so keep this file free of secrets and private details.

## Rules that govern this repo

1. **Evidence first.** A claim of "works" needs real output: test results, CI run URLs, command output. "Builds cleanly" is not evidence.
2. **Additive changes to the existing page.** The LIVE / 24h Schedule experience is preserved. Changes to `index.html` happen only inside `DAILY-PLAYLIST:BEGIN/END` marker blocks, and `npm run check:additive` proves nothing else changed.
3. **Step-gated work.** Each step is one reviewable unit: commit, push, post a report as a PR comment, stop for confirmation before the next step. Reports live in PR comments, never in tracked files.
4. **No secrets, ever.** Configuration lives in repository variables (`AJN_EXPORT_BASE_URL`, `PUBLISH_ENABLED`) and `config/channels.json`. Nothing credential-like is committed or logged. Failure logs carry reason codes and counts, not raw URLs or titles.
5. **Least privilege.** Every workflow job declares its own minimal `permissions`. Third-party actions are pinned to full commit SHAs with the version in a comment. Existing `static.yml` is left unchanged unless a diff proves it must change.
6. **Fail closed, visibly.** No silent fallbacks, no substitute media, no invented titles, durations, IDs, rights data or repeats. A failure becomes an explicit state (`error`, `no_playlist`, a visible player error), never a quiet skip.
7. **Generated data only through the workflow.** Files under `daily/` are written by the generator, committed by the workflow from an explicit path allowlist (never `git add -A`), and only when content actually changed.
8. **Untrusted text is inert.** Titles and URLs from feeds are rendered with `textContent`/DOM APIs only. Every playable URL is re-validated (https, host exactly `archive.org`, `/download/`, `.mp4`) before it reaches a `<video>`.
9. **Tests are offline.** Unit tests stub `fetch` to throw. Browser tests abort every request that is not served locally. No test calls AJN or Archive.org.
10. **One source of truth.** Behavior is defined by this file, `README.md`, `config/channels.json` and the code. Do not duplicate instructions elsewhere.
11. **Publishing is off by default.** `PUBLISH_ENABLED` must be `true` and the run must not be a dry run. Rights approval is a separate owner decision from playability.

## Workflow conventions

- Branch names: `build/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Commits: one logical change each; the subject says what, the body says why.
- Pull requests: open as draft early, with a summary of problem, solution and validation. Use the PR template.
- Merging: squash-merge the feature PR so that rollback is a single revert of one commit.
- Rollback: revert the feature PR. There is no pre-wipe tag.
- Keep `main` deployable: merge only with a green `ci.yml` run.

## Adopted from the general GitHub tips list

| Practice | Where it is enforced |
|---|---|
| Descriptive branches, small focused commits, meaningful messages | Conventions above |
| Draft PRs early; PR template; clear PR summaries | Draft PR #2, `.github/pull_request_template.md` |
| Review with a checklist; review tests along with code | PR template checklist |
| CI on every PR; fail fast; keep logs/artifacts for debugging | `ci.yml`; dry-run artifact upload (7-day retention) |
| Never commit secrets; use variables | Rule 4 |
| Aggressive `.gitignore` | Existing `.gitignore` plus appended patterns |
| Pin critical dependencies and actions | Rule 5; exact Playwright version; committed `package-lock.json` |
| Document setup, limits and rollback; keep one canonical doc | `README.md`, Rule 10 |
| Write comments for why, not what | Code review expectation |
| Reproducible workflows over "works on my machine" | Node 22 only, `npm ci`, offline tests |

## Not adopted yet (deliberate)

| Practice | Reason / revisit trigger |
|---|---|
| Dependabot | Would open automated PRs; useful for SHA-pinned actions. Revisit after the first stable release. |
| CODEOWNERS, CONTRIBUTING, SECURITY, issue forms | Single-owner repo today. Add when a second contributor joins. |
| Discussions, saved replies, project boards, milestones | No team workflow needs them yet. |
| Releases and tags | The site is continuously deployed, not versioned. |
| Fork syncing | Not a fork. |

## Branch protection caution (owner decision, not automatic)

Protecting `main` with "require a pull request before merging" would also block the publish job, which pushes generated `daily/` files directly to `main` as `github-actions[bot]`. Before enabling that rule, either allow the Actions bot to bypass it or change publishing to a PR/data-branch flow. Required status checks on `ci.yml` alone do not conflict with the bot.
