# Architecture

This document explains how the Obsidian Git plugin is put together: what the
main pieces are, how a user action flows through them, and where new code
should go. For build/test commands and coding conventions see
[`AGENTS.md`](AGENTS.md); for the test setup see
[`tests/README.md`](tests/README.md); for the line authoring internals see
[`docs/dev/LineAuthorFeature.md`](docs/dev/LineAuthorFeature.md).

For the desktop stash extension in this fork, see
[`ARCHITECTURE-STASH.md`](ARCHITECTURE-STASH.md). It maps the commands, dialogs,
native Git safeguards, and E2E validation onto the layers below.

## Big picture

```
                         ┌──────────────────────────────────────────┐
  Obsidian events        │               ObsidianGit                │
  (vault modify/create,  │               (src/main.ts)              │
   file-menu, leaf       │  lifecycle · settings · state · refresh  │
   change, layout ready) │  displayMessage / displayError           │
          │              └──┬──────────┬───────────┬─────────────┬──┘
          ▼                 │          │           │             │
  ┌───────────────┐         │          │           │             │
  │ commands.ts   │─┐       │          │           │             │
  │ UI (Svelte)   │ │  PromiseQueue    │           │             │
  │ Automatics    │─┼──▶ (serializes  ─┘           │             │
  │ file menus    │ │    mutations)                │             │
  └───────────────┘ │       │                      │             │
                    │       ▼                      ▼             ▼
                    │  ┌──────────────┐   ┌───────────────┐ ┌──────────────┐
                    └─▶│ GitActions   │   │ Editor        │ │ Status bars  │
                       │ (gitActions) │   │ integration   │ │ Views/Modals │
                       │ UX + policy  │   │ (CodeMirror)  │ └──────────────┘
                       └──────┬───────┘   └──────┬────────┘
                              │ runGitAction      │
                              ▼                   ▼
                       ┌─────────────────────────────────┐
                       │ GitManager (abstract contract)  │
                       │ src/gitManager/gitManager.ts    │
                       └──────┬───────────────────┬──────┘
                              ▼                   ▼
                   ┌──────────────────┐  ┌────────────────────┐
                   │ SimpleGit        │  │ IsomorphicGit      │
                   │ desktop, native  │  │ mobile, pure JS    │
                   │ git via          │  │ isomorphic-git +   │
                   │ simple-git       │  │ MyAdapter (vault   │
                   │                  │  │ FS) + requestUrl   │
                   └──────────────────┘  └────────────────────┘
```

The plugin is a single esbuild bundle (`src/main.ts` → `main.js`, CommonJS,
Svelte compiled with injected CSS). `obsidian`, `electron`, Node built-ins, and
CodeMirror packages are externals provided by the Obsidian runtime.

## Layers

### 1. Plugin orchestration — `src/main.ts`

`ObsidianGit extends Plugin` is the composition root. It owns:

-   **Lifecycle.** `onload` loads/migrates settings, adds the settings tab,
    calls `registerStuff()` once (events, views, ribbon icon, editor
    extensions, commands), then runs `init()` when the workspace layout is
    ready. `onunload` calls `unloadPlugin()`.
-   **`init()`** picks the backend (`SimpleGit` when `Platform.isDesktopApp`,
    else `IsomorphicGit`), runs `checkRequirements()` (`valid` /
    `missing-repo` / `missing-git`), and on success sets `gitReady`, creates
    status bars, activates editor features, fires the refresh/head-change
    events, optionally pulls on boot, and starts automatic routines.
-   **Settings reload.** `reloadSettings()` (triggered by external settings
    changes) compares the serialized settings and, if changed, does
    `unloadPlugin()` → `init({ fromReload: true })` and reloads open views.
    Anything created in `init` must therefore be torn down in `unloadPlugin`.
-   **Shared state.** `state: PluginState` (`operation`, `offlineMode`,
    `mergeInProgress`), `cachedStatus`, `gitReady`, `promiseQueue`.
-   **User feedback.** `displayMessage`, `displayError`, `handleConflict`,
    `handleNoNetworkError` (switches to offline mode and stops repeating
    network errors).

### 2. User entry points

All of these end up calling `plugin.gitActions.*`, and anything that mutates
the repository is wrapped in `plugin.promiseQueue.addTask(...)`:

| Entry point           | Location                                               |
| --------------------- | ------------------------------------------------------ |
| Command palette       | `src/commands.ts` (`addCommmands`) — stable IDs        |
| Source control view   | `src/ui/sourceControl/` (Svelte)                       |
| History view          | `src/ui/history/` (Svelte)                             |
| File explorer menu    | `ObsidianGit.handleFileMenu` in `src/main.ts`          |
| Automatic routines    | `src/automaticsManager.ts`                             |
| Hunk actions (editor) | `src/editor/signs/hunkActions.ts`                      |

### 3. Git actions — `src/gitActions.ts`, `src/gitAction.ts`

`GitActions` is the "application service" layer: it implements user-level
workflows such as commit-and-sync, commit, pull, push, fetch, branch
switch/create/delete, remotes, clone, init, discard, and `.gitignore` edits.
It decides _policy_ (e.g. pull-before-push, `syncMethod`, whether to stage all
on an empty index, whether a push remote is set, confirmation modals, commit
message templates/scripts), and then calls `GitManager` primitives.

Each workflow follows the same shape:

```ts
async commit(opts) {
    const r = await this.runReadyGitAction(() => this.performCommit(opts));
    if (r.status === "success") this.reportCommitResult(r.value);
    return r;
}
```

-   `performX` does the work and returns a typed, discriminated result
    (`{ status: "committed" | "nothing-to-commit" | "skipped", ... }`).
-   `reportX` turns that result into notices via an exhaustive `switch`.
-   `runReadyGitAction` ensures the plugin is initialized (retrying `init` via
    `isAllInitialized()`), and delegates to `runGitAction`.
-   `runGitAction` (`src/gitAction.ts`) catches everything and routes errors:
    `UserCanceledError` → `cancelled`, `GitConflictError` → refresh status and
    `handleConflict`, `NoNetworkError` → offline mode, anything else →
    `displayError`. It returns `GitActionResult<T>` =
    `success | failed | cancelled`.
-   `runFileStateMutation` is the variant for stage/unstage/discard/etc. that
    fires `obsidian-git:refresh` afterwards.

### 4. Git backends — `src/gitManager/`

`GitManager` is the abstract contract for shared Git operations
(`status`, `commit`, `stage`, `pull`, `push`, `log`, `show`, `branchInfo`,
`clone`, config/remote management, …). It also contains shared logic:

-   `withGitOperation(op, fn)` — sets `state.operation` (drives the status
    bar) and always restores `idle` in `finally`.
-   Path translation between **vault-relative** and **repo-relative** paths
    (`getRelativeVaultPath` / `getRelativeRepoPath`, based on the `basePath`
    setting). The rest of the plugin speaks vault paths; repo paths stay
    inside the manager.
-   `getVaultPathspec` / `isPathInsideVault` — when the repository root is a
    parent of the vault and `limitToVault` is on, file operations are scoped
    to the vault directory.
-   `getTreeStructure` (builds the folder tree used by the views) and
    `formatCommitMessage` (`{{date}}`, `{{numFiles}}`, `{{files}}`,
    `{{hostname}}`).

| Backend                           | Platform          | How it talks to Git                                                                                                                                                                  |
| --------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SimpleGit` (`simpleGit.ts`)      | Desktop           | Spawns the user's native `git` through `simple-git`. Supports custom git path, extra `PATH`/env vars, `GIT_DIR`, an askpass script for credentials, progress reporting, raw commands, patches. |
| `IsomorphicGit` (`isomorphicGit.ts`) | Mobile (and fallback) | `isomorphic-git` in JS. File access goes through `MyAdapter` (`myAdapter.ts`), an fs shim over Obsidian's `DataAdapter`; HTTP goes through Obsidian's `requestUrl`; auth via `onAuth` prompts. |

Some features exist only on desktop and are gated with
`gitManager instanceof SimpleGit` or `plugin.useSimpleGit` — e.g. line
authoring, gutter signs/hunks, applying patches, raw commands, the branch
status bar, parent-repository scoping, and stash management. Stash calls
`SimpleGit` methods directly and inherits `GitManager.withGitOperation`;
see [stash architecture](ARCHITECTURE-STASH.md). Any change to the shared contract
must be implemented in **both** backends; `tests/gitManager/gitManager.test.ts`
runs the same assertions against both.

### 5. Concurrency — `src/promiseQueue.ts`

`PromiseQueue` is a simple FIFO that runs one async task at a time. It
serializes everything that touches the working tree, index, or refs so that,
e.g., an auto-commit timer firing during a manual pull does not race. Task
rejections are logged and do not stall the queue; `clear()` drops pending
tasks on unload. Read-only refreshes (`updateCachedStatus`) are not queued.

### 6. Automatic routines — `src/automaticsManager.ts`

Manages timers for auto commit-and-sync, auto push, and auto pull. On
`init()` it computes the remaining time from the last run (persisted in local
storage) so intervals survive restarts. With "auto backup after file change",
it installs `plugin.autoCommitDebouncer`, which vault `modify/create/delete/
rename` events poke. `reload(...types)` restarts timers after a settings change;
`unload()` clears them. All runs go through `promiseQueue`. Automatics can be
paused via local storage.

### 7. Refresh and events

The plugin uses custom workspace events as a lightweight bus between the
orchestrator and views:

| Event                          | Meaning                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `obsidian-git:refresh`         | Request: recompute status (handled by `ObsidianGit.refresh`).           |
| `obsidian-git:loading-status`  | Status computation started (views show a spinner).                      |
| `obsidian-git:status-changed`  | New `Status` available (payload); source control view re-renders.       |
| `obsidian-git:refreshed`       | Refresh finished.                                                       |
| `obsidian-git:head-change`     | HEAD moved (commit/pull/checkout); history view and editor features reload. |
| `obsidian-git:menu`            | Plugin-originated file context menu.                                    |

Vault change events call the debounced `debRefresh` (interval from
`refreshSourceControlTimer`). `refresh()` only runs `git status` when someone
needs it (an open, non-deferred source control/history view or the
changed-files status bar), which keeps idle cost low.

### 8. UI — `src/ui/`

-   **Views** (`ItemView` subclasses registered in `registerStuff`, IDs in
    `src/constants.ts`):
    -   `sourceControl/` — the staging/commit panel. `sourceControl.ts` mounts
        `sourceControl.svelte`, which listens for status events and triggers
        actions through `promiseQueue` + `gitActions`.
    -   `history/` — commit log with per-commit file trees (Svelte).
    -   `diff/diffView.ts` — unified diff rendered with `diff2html`.
    -   `diff/splitDiffView.ts` — side-by-side editable diff using
        `@codemirror/merge`.
    -   `readOnlyFileView.ts` — shows a file at a given revision.
-   **Modals** (`ui/modals/`) — branch picker, commit message, discard
    confirmation, `.gitignore` editor, changed files, merge-conflict help, and
    a generic suggester (`generalModal.ts`).
-   **Status bars** — `src/statusBar.ts` (current operation, progress,
    messages, last commit time), `ui/statusBar/branchStatusBar.ts` (desktop
    branch switcher), `editor/signs/changesStatusBar.ts` (hunk counts).

### 9. Editor integration — `src/editor/`

`EditorIntegration` wires CodeMirror 6 features into Obsidian editors:

-   **Subscription model.** `control.ts` registers an editor extension that
    subscribes each open editor by file path; `eventsPerFilepath.ts` is the
    pub-sub registry used to push computed results to every editor showing
    that file.
-   **Line authoring** (`lineAuthor/`) — runs `git blame` via `SimpleGit`,
    caches results, and renders a gutter with author/date/color. Desktop only.
    See `docs/dev/LineAuthorFeature.md`.
-   **Signs & hunks** (`signs/`) — compares the buffer to the index version
    (`gitManager.show("", path)`), computes hunks (`diff.ts`, `hunks.ts`,
    `hunkState.ts`), draws gutter markers, shows inline diff tooltips, and
    offers stage/reset hunk commands (`hunkActions.ts`, which builds patches
    and applies them through `GitActions`). Desktop only.
-   **Conflicts** (`conflicts/`) — detects conflict markers and adds
    accept-current/incoming/both actions in the editor.

Each feature has `activateFeature` / `deactivateFeature` and is toggled by
settings; `onUnloadPlugin` tears everything down.

### 10. Settings — `src/setting/`

-   `settings.ts` — `ObsidianGitSettingsTab`, built on Obsidian's declarative
    settings API, with a custom sub-page for line authoring. Changing a setting
    often calls into the relevant subsystem (e.g.
    `automaticsManager.reload("commit")`, `editorIntegration.refreshSignsSettings()`).
-   Persisted, synced settings live in `data.json` (`ObsidianGitSettings`,
    defaults in `DEFAULT_SETTINGS` in `src/constants.ts`, merged by
    `mergeSettingsByPriority`). Old keys are migrated in
    `ObsidianGit.migrateSettings`.
-   `localStorageSettings.ts` — **per-device** values that must not sync with
    the vault: git binary path, password/username, hostname, extra PATH/env
    vars, last auto-run timestamps, paused automatics, plugin disabled flag.

### 11. Misc

-   `src/types.ts` — shared domain types (`Status`, `FileStatusResult`,
    `LogEntry`, result unions), `GitOperation`, error classes
    (`GitConflictError`, `NoNetworkError`), settings type.
-   `src/utils.ts` — helpers (path/gitignore utils, `spawnAsync`, exhaustive
    switch helpers, remote/branch splitting).
-   `src/tools.ts` — checks such as "files too large for GitHub".
-   `src/openInGitHub.ts` — open file/line/history on GitHub.
-   `src/pluginGlobalRef.ts` — global plugin reference used by editor gutter
    menus that can't easily receive it through CodeMirror.

## Walkthrough: "Commit and sync"

1. User runs the command (or a timer fires in `AutomaticsManager`).
2. `commands.ts` enqueues
   `promiseQueue.addTask(() => gitActions.commitAndSync({ fromAutoBackup: false }))`.
3. `runReadyGitAction` ensures `gitReady`, then `performCommitAndSync`:
    - optionally pulls first (`syncMethod` / `pullBeforePush`),
    - `performCommit` → `updateCachedStatus()`, resolve stage mode, format
      message (`gitManager.formatCommitMessage`), `gitManager.commitAll(...)`,
    - pulls if configured, checks `disablePush` / push remote /
      `gitManager.canPush()`, then `performPush`.
4. Inside each backend call, `withGitOperation` sets `state.operation`, so the
   status bar shows "committing…/pushing…", and restores `idle` afterward.
5. Results are reported via `reportCommitResult` / `reportPushResult` →
   `displayMessage`; errors bubble to `runGitAction` → conflict/offline/error
   handling.
6. `obsidian-git:refresh` / `head-change` are fired; views re-render from the
   new `Status`.

## Where to put a change

| You want to…                                    | Touch                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Add a new Git primitive                         | `GitManager` abstract + `SimpleGit` + `IsomorphicGit` + contract tests    |
| Add a desktop-only Git capability               | `SimpleGit` + desktop/backend gates in commands and `GitActions`; see [stash architecture](ARCHITECTURE-STASH.md) |
| Add a user workflow / change UX of an operation | `GitActions` (perform/report pair), result types in `types.ts`            |
| Add a command                                   | `src/commands.ts` (keep IDs stable; queue mutations)                      |
| Add a setting                                   | `types.ts`, `DEFAULT_SETTINGS`, `settings.ts`, migrate in `main.ts` if renaming |
| Per-device secret/path                          | `localStorageSettings.ts`                                                 |
| New timer/extension/status bar element          | create in `init`/feature activate, destroy in `unloadPlugin`/deactivate   |
| Editor gutter or inline behavior                | `src/editor/…`, via `eventsPerFilepath` subscriptions                     |
| Panel UI                                        | the Svelte component + its `ItemView`; talk to the plugin via events/`gitActions` |

## Tests

Vitest in Node with an `obsidian` stub (`tests/stubs/obsidian.ts`). Git
behavior is tested against real temporary repositories; the GitManager
contract suite runs against both backends. Pure logic (hunks, diff, conflict
model, queue, `runGitAction`) has focused unit tests. See `tests/README.md`.

Desktop stash is validated through the built plugin in real Obsidian with native
Git. See [stash architecture](ARCHITECTURE-STASH.md#validation-and-local-installation)
and [the E2E guide](tests/e2e/README.md) for its separate runner and replayable
evidence.
