# Desktop-only Git stash plan

Status: complete. Desktop stash implemented; E2E, artifact replay, repository
checks, and production build pass. Local install bundle is ready.

Add manual stash management to this local fork using native Git. Backend
changes stay in `SimpleGit`; command registration, workflows, modals, types,
and status reporting need supporting changes.

## Working rules

-   Prefer E2E as the sole mechanism for testing new feature behavior. Exercise
    the built plugin in desktop Obsidian with real Git and disposable vaults.
-   Never write unit tests after implementation. Any necessary unit tests must
    precede the code changes they cover.
-   If testing a system in isolation is necessary, first document all identified
    ways it could fail and why E2E cannot adequately cover them. Write required
    unit tests before implementing or changing that behavior.
-   Do not add comments to any new or modified files, including source, tests,
    and configuration. Put explanations in this plan and user documentation.
-   Keep `plan.md` current throughout the work: update progress, decisions,
    failure modes, scope changes, and verification evidence as they occur.
-   Every E2E run must finish by producing a verifiable, repeatable evidence
    artifact, including failed runs.

## Scope

-   Desktop only, gated by `Platform.isDesktopApp` and `instanceof SimpleGit`.
-   Follow the existing desktop-only patch/raw-command pattern. Leave the shared
    `GitManager` contract and `IsomorphicGit` unchanged for this feature.
-   Use ordinary Git stashes, compatible with the terminal and other Git tools.
-   Support a repository rooted at the vault or in a vault subfolder. Reject
    parent repositories in this first version, regardless of `limitToVault`.
-   Operate on the current repository only; do not recurse into submodules.
-   No new runtime dependencies, settings page, or persistent stash panel.
-   Defer patch/partial stashes, stash-clear, and automatic stash-before-pull.

## Commands and behavior

| Command ID    | Palette name  | Behavior                                                                                                                  |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `stash-push`  | Stash changes | Prompt for an optional message and whether to include untracked files. Save changes and restore the working tree to HEAD. |
| `stash-list`  | List stashes  | Show a searchable picker with stash reference, message, and date. Selection is informational.                             |
| `stash-apply` | Apply stash   | Select a stash and restore its changes, keeping the stash.                                                                |
| `stash-pop`   | Pop stash     | Select a stash, restore it, and remove it only after successful restoration.                                              |
| `stash-drop`  | Drop stash    | Select a stash and confirm deletion.                                                                                      |

-   Include untracked files by default so newly created notes are shelved too;
    the creation dialog explains that these files temporarily disappear.
-   Preserve ignored files. Never pass `--all`.
-   Apply/pop offer a **Restore staging** checkbox, off by default. Enabling it
    passes `--index`; otherwise use Git's ordinary restoration behavior.
-   Cancelling any dialog makes no repository changes.
-   Report empty stash lists and nothing-to-stash as normal outcomes.
-   Keep stashes local; ordinary commit-and-sync does not transfer them.

## Backend design

Add focused methods to `SimpleGit`:

```ts
listStashes(): Promise<StashEntry[]>
stashPush(options: StashCreateOptions): Promise<StashCreateResult>
stashApply(entry: StashEntry, restoreIndex: boolean): Promise<void>
stashPop(entry: StashEntry, restoreIndex: boolean): Promise<StashPopResult>
stashDrop(entry: StashEntry): Promise<void>
```

-   `StashEntry` carries the reflog reference, full commit hash, message, and date.
-   Parse an explicitly formatted native stash list; do not depend on Git's
    default display format or localized success messages.
-   Use argument arrays with `simple-git`, including messages as single arguments.
-   Wrap mutations in `withGitOperation(GitOperation.stash, ...)` so failures
    always restore the idle state.
-   Validate the actual working-tree root against the vault boundary before
    mutations. `absoluteRepoPath` alone may not identify a parent repository.
-   Refuse push/apply/pop during unresolved conflicts or an unfinished
    merge/rebase. Creation also requires an existing HEAD commit.
-   Let native Git protect existing edits during restoration. Never force
    checkout, reset, or discard files to make application succeed.

**Selected-stash identity:** references such as `stash@{1}` can shift while a
dialog is open. Re-list immediately before acting and require the selected
reference to still match its recorded hash. If it changed, stop and ask the
user to select again. Apply by the validated hash.

**Pop:** apply first, then revalidate and drop the selected reflog entry. If
application conflicts, retain the stash. If restoration succeeds but deletion
fails or the list changes, report “changes restored; stash retained” as a
distinct outcome. Do not automatically apply again. The plugin queue cannot
serialize external Git tools; revalidation reduces that race but is not an
atomic lock across processes.

## Workflow and UI integration

1. Register the five commands in `src/commands.ts`, with desktop/backend gates.
2. Queue each workflow through `PromiseQueue`, including dialog selection,
   following the existing branch-switch pattern.
3. In `GitActions`, check readiness and the desktop backend again, then invoke
   the relevant `SimpleGit` method.
4. Reuse the existing modal patterns: a creation dialog, a fuzzy stash picker
   with restore options, and an explicit drop confirmation.
5. Route errors through `runGitAction`. Convert native restoration conflicts
   into `GitConflictError` so existing conflict UI handles them.
6. Request a source-control refresh after working-tree mutations, including
   partial restoration on failure. Stash operations do not move HEAD, so do
   not emit `head-change` solely to refresh views.
7. Add a stash operation label/icon to the status bar and include its class in
   operation-state cleanup.

Keep current automatic-routine settings. Queuing prevents plugin Git mutations
from running concurrently, but restored files remain eligible for later
automatic commits. Document the existing pause/resume command for users who
want to shelve, pull/switch branches, and restore without an intervening
automatic commit.

Verify open-note save timing inside Obsidian: pending saves must not write old
editor contents back over stashed/restored files. Inspect supported Obsidian
save coordination if needed; do not assume the queue controls editor writes.
This is an acceptance check, not something the test stub can establish.

## Expected files

| File                                                       | Change                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/gitManager/simpleGit.ts`                              | Native stash operations, validation, identity checks, and conflict conversion.                           |
| `src/gitActions.ts`                                        | Dialog workflows, outcomes, notices, and refresh handling.                                               |
| `src/commands.ts`                                          | Desktop-only command registration and queueing.                                                          |
| `src/types.ts`                                             | Stash data/result types and `GitOperation.stash`.                                                        |
| `src/statusBar.ts`                                         | Stash operation display and cleanup.                                                                     |
| `src/ui/modals/stashModal.ts`                              | Creation and selection modals; reuse existing confirmation patterns.                                     |
| `scripts/e2e/stash.mjs`                                    | Playwright drives the built plugin in real desktop Obsidian and creates synthetic fixtures and evidence. |
| `tests/e2e/README.md`                                      | Setup, expected results, and replay instructions.                                                        |
| E2E runner configuration, `package.json`, `pnpm-lock.yaml` | A repeatable `test:e2e:stash` command and test-only tooling if needed.                                   |
| `.gitignore`                                               | Keep generated E2E evidence out of source control.                                                       |
| `README.md`, `docs/Features.md`                            | Commands, desktop scope, restoration semantics, and local-only storage.                                  |

Preserve existing command IDs. Document stash internals and their connection to
the existing layers in [ARCHITECTURE-STASH.md](ARCHITECTURE-STASH.md).
Keep `ARCHITECTURE.md` as a local reference outside the public branch.

## Failure modes to cover before implementation

Maintain this inventory before coding. Expand it before any isolated testing.

| Failure                                                            | Required evidence                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Saved contents or staging are lost                                 | Exact staged/unstaged contents survive restoration, with and without `--index`.      |
| New or ignored files are handled incorrectly                       | Untracked inclusion/exclusion works; ignored files remain unchanged.                 |
| Deletions, renames, binary files, or unusual paths break           | Round trips preserve bytes and file presence for all these cases.                    |
| A clean tree or empty stash list produces misleading success       | Correct no-op notice; no stash or file mutation.                                     |
| Restoration overwrites existing edits or drops a conflicting stash | Existing edits preserved on refusal; conflicts visible; stash retained.              |
| A stale picker reference acts on the wrong stash                   | External stash-list changes cause selection to be rejected.                          |
| Apply succeeds but pop deletion fails                              | Restored contents remain; saved copy retained; partial outcome reported.             |
| Cancellation or confirmation mishandling changes files             | Cancel at each dialog; drop requires confirmation.                                   |
| Wrong repository scope changes unrelated files                     | Parent repositories rejected; nested repositories supported; submodules untouched.   |
| Missing HEAD or unfinished merge/rebase permits unsafe mutations   | Clear error and unchanged repository state.                                          |
| Queue bypass or error leaves the plugin stuck                      | Competing plugin actions serialize; operation state returns to idle.                 |
| Open-editor saves overwrite Git results or UI stays stale          | Open notes and source control match disk after success and partial failure.          |
| Automatics commit unexpectedly during a queued workflow            | No concurrent plugin mutation; later automatic behavior matches documented settings. |
| Stash commands become available on mobile                          | Desktop/backend gates verified; unsupported backends cannot dispatch stash actions.  |

## E2E strategy and evidence artifact

Establish a runner that launches desktop Obsidian, loads the production bundle,
and drives commands and dialogs in synthetic vaults. Select compatible tooling
before adding dependencies; record the choice here. Backend-only calls are not
a substitute for the primary E2E acceptance suite.

Write the E2E scenarios before feature implementation and confirm the initial
failure is caused by missing stash behavior. Use native Git and filesystem
snapshots as independent checks of the UI results. Simulate external stash
changes and drop failures through controlled fixtures. If a case cannot be
covered through E2E, record the gap and failure analysis before considering an
isolated test.

Each run writes `artifacts/e2e/stash/<run-id>/` and an archive containing:

-   A machine-readable report with scenario results and assertion failures.
-   Screenshots of key dialogs, successful restoration, and conflict handling.
-   Before/after file hashes, index contents, Git status, and stash references.
-   Tool versions, tested plugin checksum, fixture inputs, and expected outputs.
-   The exact rerun command and fixture-creation script.

Use fixed fixture inputs and explicit repository configuration. The artifact
must let someone recreate the test vault and independently check the assertions.
Repeatability means the same checks and expected results, not identical screenshot
timestamps. A failed run must still save available evidence and exit nonzero.

Run existing repository checks for regressions; do not add new unit-test suites
by default. Type, Svelte, lint, format, and build checks supplement E2E validation.

## Implementation and validation order

1. Use Node >=24 and pnpm >=11. This environment currently has Node 25 and
   pnpm 10, and dependencies were absent during investigation. Install existing
   dependencies; commit lockfile changes if E2E tooling requires additions.
2. Review the failure inventory, select the E2E runner, write scenarios, and
   establish the failing baseline and evidence generation before feature code.
3. Implement backend types and safeguards, then workflows, modals, commands,
   and status reporting. Add no file comments. Update this plan as work proceeds.
4. Build the plugin and run E2E through `pnpm run test:e2e:stash`. Inspect the
   evidence artifact and fix failures until the acceptance scenarios pass.
5. Run `pnpm run all` and `pnpm run build`. Rerun relevant E2E scenarios if
   subsequent changes affect behavior or the tested bundle.
6. Verify the replay instructions work from a fresh fixture; link the final
   evidence artifact here. Update documentation and deliver the local release
   artifacts: `main.js`, `manifest.json`, and `styles.css`.

Installation into the user's working vault is outside this implementation.
The E2E runner installs the build only into its disposable vault.

## Progress

-   [x] Investigate architecture and native stash behavior.
-   [x] Draft plan and incorporate the user's testing and no-comment rules.
-   [x] Complete user review of scope and behavior.
-   [x] Select E2E tooling and create the failing baseline with evidence output.
-   [x] Implement desktop stash functionality.
-   [x] Pass E2E acceptance scenarios and repository checks.
-   [x] Verify artifact replay and deliver the local bundle.

## Decision and verification log

| Date       | Update                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-02 | Desktop only; use SimpleGit-specific methods and existing desktop gates.                                                                                                                                                                                                                                                                                                    |
| 2026-10-02 | Prefer E2E only for new behavior; any unit tests must precede implementation and isolated testing requires written failure analysis.                                                                                                                                                                                                                                        |
| 2026-10-02 | Add no comments to changed files; maintain this plan throughout implementation.                                                                                                                                                                                                                                                                                             |
| 2026-10-02 | Native Git investigation passed round-trip and conflict-retention checks. No built-plugin E2E run has occurred.                                                                                                                                                                                                                                                             |
| 2026-10-02 | Implementation authorized. Selected `playwright-core` with the installed Obsidian executable and a separate user-data profile. Reuse the installed updated Obsidian application archive in that profile; no personal vault is loaded.                                                                                                                                       |
| 2026-10-02 | Dependencies installed with pnpm 11.28.3. Added only the test dependency `playwright-core` 1.63.0. E2E code lives under `scripts/e2e` to avoid changing the existing Vitest setup.                                                                                                                                                                                          |
| 2026-10-02 | Playwright connects over a loopback debugging endpoint because Electron inspector launch timed out with the installed launcher. The real Obsidian baseline fails because `stash-push` is not registered. Evidence: `artifacts/e2e/stash/2026-10-02T14-14-36.829Z/report.json`. No feature code preceded the scenarios.                                                      |
| 2026-10-02 | Use public `TextFileView.save()` to flush open text-file edits before working-tree mutations; verify delayed saves and editor refreshes through E2E.                                                                                                                                                                                                                        |
| 2026-10-02 | E2E exposed `simple-git` accepting a nonzero stash-apply exit when stderr is empty. Check unresolved conflicts explicitly after application, before pop can drop the saved copy.                                                                                                                                                                                            |
| 2026-10-02 | Set `GIT_OPTIONAL_LOCKS=0` in the disposable test process so background status reads cannot race fixture resets for the index lock. Production Git configuration is unchanged.                                                                                                                                                                                              |
| 2026-10-02 | All 15 built-plugin E2E scenarios pass, including pending editor saves and conflicting pop. Evidence: `artifacts/e2e/stash/2026-10-02T14-33-28.442Z/report.json`. TypeScript, Svelte, and lint checks also pass; full regression checks and frozen-bundle replay remain.                                                                                                    |
| 2026-10-02 | Full regression run reaches Vitest but 45 existing native-backend tests fail on Node 25's experimental `localStorage` getter. Rerun with `NODE_OPTIONS=--no-experimental-webstorage`; no new unit tests or production workaround are needed.                                                                                                                                |
| 2026-10-02 | Full checks pass with `NODE_OPTIONS=--no-experimental-webstorage pnpm dlx pnpm@11 run all`: TypeScript, Svelte, formatting, lint, and all 131 existing tests. Final E2E suite also passes all 15 scenarios; its archive includes dialog screenshots, frozen bundle, replay script, intermediate snapshots, and checksums. All archived checksums verified after extraction. |
| 2026-10-02 | Frozen-bundle replay passes all 15 scenarios from a newly created vault/profile. Replay, original run, production build, and install ZIP share the same `main.js` checksum. Production build passes; ZIP contains exactly `main.js`, `manifest.json`, and `styles.css`. Reviewed creation/restoration/conflict screenshots.                                                 |
| 2026-10-02 | Verification was on macOS, with Obsidian 1.13.7 and native Git. Mobile command/backend gates were reviewed; no physical mobile run or other-desktop launcher run was performed. No new unit tests or implementation comments were added.                                                                                                                                    |

Final E2E run: `2026-10-02T14-38-56.381Z`.
Replay run: `2026-10-02T14-42-57.676Z`.

Evidence reports, archives, test profiles, and the local install ZIP remain under
ignored `artifacts/`. They are local outputs and are not part of a public checkout.
Run `pnpm run test:e2e:stash` to create new evidence and use the E2E guide to replay
the saved bundle.

Installation and testing: [guide](tests/e2e/README.md).

## Architecture documentation follow-up

-   [x] Add `ARCHITECTURE-STASH.md` with the implemented flow, source map,
        safeguards, and validation architecture.
-   [x] Explain shared versus desktop-only backend capabilities in the stash
        architecture document without requiring the local overview.
-   [x] Verify document formatting and relative file links; `git diff --check`
        passes.

## Public sharing review

Reviewed all 17 changed/untracked files. No hardcoded credentials, personal
account paths, or personal vault contents were found. The E2E email is the
synthetic `stash@example.invalid`; launcher paths and environment overrides are
generic. `artifacts/`, `main.js`, and `node_modules/` are ignored and untracked.
Keep generated vaults, profiles, logs, app archives, and release ZIPs excluded.

This plan is included as requested development documentation. Local evidence
paths are identified as generated outputs. Public documentation describes how
to build and install the fork without requiring a locally prepared ZIP.

## Pull request preparation

Target: `michael-han-dev/obsidian-git-michael`, base `master`, head `feat/git-stash`.
Include source, dependency/lockfile changes, E2E tooling, documentation, and this
plan. Keep all generated/local artifacts excluded. Use the Vercel AI SDK title
format and description sections; write the description in concise ASD-STE100
Simplified Technical English. Leave the pull request open and unmerged.

The user will create the pull request manually. Commit and push the feature
branch, then provide the title and description for the user's PR form.

Publication follow-up: remove `ARCHITECTURE.md` from Git as requested, preserve
the local file through a local exclude rule, and remove public links to it.
Commit and push the documentation change without merging the feature branch.
