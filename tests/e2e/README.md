# Desktop stash E2E

The stash suite runs the production plugin in real desktop Obsidian with native
Git. It drives commands and dialogs, then checks files, staging, and stash refs
independently through the Git CLI. No new stash unit tests are used.

## Run

Requirements: Node >=24, pnpm >=11, Git, and an installed desktop Obsidian.
Verified on macOS with Obsidian 1.13.7. The default launcher is
`/Applications/Obsidian.app/Contents/MacOS/Obsidian`.

```sh
pnpm install --frozen-lockfile
pnpm run test:e2e:stash
```

The runner builds and copies the plugin into a new disposable vault under
`artifacts/e2e/stash/<run-id>/vault/`. Obsidian uses a separate profile and a
loopback debugging endpoint. Your normal vault and plugin installation are not
used. The test process disables optional Git read locks and automatic plugin
routines to make fixture setup repeatable.

On macOS, the runner copies the latest cached Obsidian application archive into
the test profile. Override `OBSIDIAN_EXECUTABLE` or `OBSIDIAN_APP_ASAR` if needed:

```sh
OBSIDIAN_EXECUTABLE="/path/to/Obsidian" OBSIDIAN_APP_ASAR="/path/to/obsidian-1.13.7.asar" pnpm run test:e2e:stash
```

Other desktop launchers have not been verified. This suite does not run on
mobile; it checks desktop command/backend gating inside Obsidian.

For the existing Vitest regression suite on Node 25, use
`NODE_OPTIONS=--no-experimental-webstorage pnpm run all` if its setup encounters
the experimental `localStorage` getter error.

## Coverage

| Scenario                                  | Main assertions                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Commands and empty list                   | All five commands exist; empty list is a normal outcome.                                                       |
| Staged/unstaged and new files             | Contents and staging round-trip with Restore staging; ignored files stay intact; list/search is informational. |
| Exclude new files and pop                 | Excluded files remain; successful pop removes the saved copy.                                                  |
| Binary, deletion, rename, staged addition | Exact bytes, presence, paths, and index survive.                                                               |
| Cancellation and drop                     | Cancel changes nothing; drop needs explicit confirmation.                                                      |
| Clean tree                                | No stash is created; nothing-to-stash notice appears.                                                          |
| Conflicting pop                           | Conflict markers and plugin conflict status appear; stash remains.                                             |
| Overlapping edits                         | Existing edits survive refused application.                                                                    |
| Stale selection                           | External changes to the stash list cause rejection.                                                            |
| Pop deletion failure                      | Files restore but the saved copy remains with a distinct notice.                                               |
| Unfinished merge/rebase                   | Mutation is refused.                                                                                           |
| Pending editor save                       | Open-note edits are saved, shelved, and restored without a delayed overwrite.                                  |
| Nested repository and missing HEAD        | Nested repo works; unborn repo is refused without losing files.                                                |
| Queue and backend gates                   | A competing queued task waits; missing native backend disables commands.                                       |
| Parent repository                         | Stash is refused without changing the parent repository.                                                       |

## Evidence and replay

Each run, including a failure, produces a `report.json` and a sibling `.tar.gz`
archive. Evidence contains screenshots, before/after and intermediate snapshots,
file hashes and bytes, index entries, stash hashes, tool versions, console logs,
the exact plugin bundle, the fixture script, and checksums. The archive excludes
the disposable vault/profile; the script recreates them. Failures exit nonzero.

To verify and replay a saved archive from this checkout:

```sh
mkdir -p artifacts/replay
tar -xzf artifacts/e2e/stash/<run-id>.tar.gz -C artifacts/replay
```

From `artifacts/replay`, run `shasum -a 256 -c checksums.sha256`. Then, from the
checkout root:

```sh
STASH_E2E_PROJECT_ROOT="$PWD" STASH_E2E_BUNDLE_DIR="$PWD/artifacts/replay" node artifacts/replay/replay.mjs
```

Replay skips the build and tests the archived bundle. Compare `pluginSha256`
and the 15 scenario results in the original and replay reports. The fixture
script contains all inputs and expected assertions; no original vault is needed.
Use the archived `package.json` and lockfile to inspect the dependency versions.

## Manual test in Obsidian

Yes, testing the commands interactively requires installing the local build
into the test vault. Follow [local installation](../../docs/Installation.md#install-this-local-fork).
The automated runner performs its own installation.

1. Create a disposable desktop vault. Initialize Git and make an initial
   commit containing a note with `base` text. Ignore `.obsidian/` for this test.
2. Install the local build in that vault and pause automatic routines with
   **Pause/Resume automatic routines**.
3. Edit the committed note and create a new note. Run **Git: Stash changes**,
   enter a recognizable message, and leave **Include untracked files** enabled.
   The committed note returns to its original contents; the new note disappears.
4. Run **Git: List stashes** and find that message. Run **Git: Apply stash**.
   Both notes return, and the saved copy remains in the list.
5. To test pop separately, drop the already-applied copy after checking the
   restored notes. Stash those edits again, then run **Git: Pop stash**. Both
   notes return and that stash disappears from the list.
6. For staging, stage one edit, then make another unstaged edit. Stash and apply
   with **Restore staging** enabled. Check the Source Control view: the original
   staged edit and the later unstaged edit should both be present.
7. For conflicts, start from a committed note, change a line and stash it.
   Change that same line differently and commit it. Pop the stash. Expect
   conflict markers and a conflict notice; **List stashes** must still contain
   the saved copy. Resolve or discard the test conflict before further work.

Optional terminal checks from the test vault:

```sh
git status --short
git stash list
git diff
git diff --cached
```

Stashes stay local and are not uploaded by push/sync. Use a vault-root repository
or configure the plugin's base path for a nested repository; parent repositories
are intentionally refused.
