import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(
    process.env.STASH_E2E_PROJECT_ROOT ||
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
);
const bundle = path.resolve(process.env.STASH_E2E_BUNDLE_DIR || root);
const runId = new Date().toISOString().replaceAll(":", "-");
const output = path.join(root, "artifacts/e2e/stash", runId);
const vault = path.join(output, "vault");
const profile = path.join(output, "profile");
const executable =
    process.env.OBSIDIAN_EXECUTABLE ||
    "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_DATE: "2026-01-01T12:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T12:00:00Z",
};
const report = {
    runId,
    rerun: "pnpm run test:e2e:stash",
    scenarios: [],
    versions: { node: process.version },
    console: [],
};
let electron;
let child;
let page;
let seed;
let activeScenario;
const screenshots = new Set();

async function captureOnce(name) {
    if (screenshots.has(name)) return;
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    screenshots.add(name);
}

function git(args, directory = vault) {
    return execFileSync(
        "git",
        [
            "-c",
            "user.name=Stash E2E",
            "-c",
            "user.email=stash@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            ...args,
        ],
        {
            cwd: directory,
            env: gitEnv,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }
    ).trimEnd();
}

async function write(name, contents, directory = vault) {
    await fs.mkdir(path.dirname(path.join(directory, name)), {
        recursive: true,
    });
    await fs.writeFile(path.join(directory, name), contents);
}

async function snapshot(directory = vault) {
    const names = git(
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        directory
    )
        .split("\0")
        .filter(Boolean);
    const files = {};
    for (const name of new Set(names)) {
        try {
            const bytes = await fs.readFile(path.join(directory, name));
            files[name] = {
                sha256: createHash("sha256").update(bytes).digest("hex"),
                base64: bytes.toString("base64"),
            };
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            files[name] = null;
        }
    }
    const state = {
        status: git(["status", "--porcelain=v1"], directory),
        stashes: git(["stash", "list", "--format=%gd %H %gs"], directory),
        index: git(["ls-files", "--stage"], directory),
        files,
    };
    if (activeScenario) {
        activeScenario.checkpoints ||= [];
        activeScenario.checkpoints.push(state);
    }
    return state;
}

async function command(id) {
    const executed = await page.evaluate(
        (id) => window.app.commands.executeCommandById(`obsidian-git:${id}`),
        id
    );
    assert.equal(executed, true, `Command obsidian-git:${id} is unavailable`);
}

async function finished() {
    await page.waitForFunction(
        () =>
            window.app.plugins.plugins["obsidian-git"].promiseQueue
                .currentTask === null
    );
    assert.equal(
        await page.evaluate(
            () => window.app.plugins.plugins["obsidian-git"].state.operation
        ),
        0
    );
}

async function push(message = "E2E stash", includeUntracked = true) {
    await command("stash-push");
    const modal = page.locator(".modal").filter({
        has: page.getByRole("heading", {
            name: "Stash changes",
            exact: true,
        }),
    });
    await modal.getByPlaceholder("Optional stash message").fill(message);
    if (!includeUntracked)
        await modal
            .getByRole("checkbox", { name: "Include untracked files" })
            .uncheck();
    await captureOnce("stash-create-dialog");
    await modal
        .getByRole("button", { name: "Stash changes", exact: true })
        .click();
    await finished();
}

async function select(id, message = "E2E stash", restoreIndex = false) {
    await command(id);
    await page.locator(".prompt-input").last().waitFor();
    if (restoreIndex)
        await page.getByRole("checkbox", { name: "Restore staging" }).check();
    await captureOnce(`${id}-picker`);
    await page
        .locator(".suggestion-item")
        .filter({ hasText: message })
        .first()
        .click();
    if (id !== "stash-drop") await finished();
}

async function setBasePath(basePath) {
    await page.evaluate(async (basePath) => {
        const plugin = window.app.plugins.plugins["obsidian-git"];
        plugin.settings.basePath = basePath;
        await plugin.reloadGitManager();
    }, basePath);
}

async function reset() {
    await page.keyboard.press("Escape");
    await page.evaluate(async () => {
        for (const leaf of window.app.workspace.getLeavesOfType("markdown"))
            await leaf.detach();
    });
    await setBasePath("");
    await fs.rm(path.join(vault, ".git/refs/stash.lock"), { force: true });
    await fs.rm(path.join(vault, ".git/MERGE_HEAD"), { force: true });
    await fs.rm(path.join(vault, ".git/rebase-merge"), {
        recursive: true,
        force: true,
    });
    git(["checkout", "-f", "main"]);
    git(["reset", "--hard", seed]);
    git(["clean", "-fd"]);
    git(["stash", "clear"]);
}

async function scenario(name, action) {
    const result = { name, status: "running" };
    report.scenarios.push(result);
    try {
        await reset();
        result.before = await snapshot();
        activeScenario = result;
        await action();
        result.status = "passed";
    } catch (error) {
        result.status = "failed";
        result.error = error.stack;
        process.exitCode = 1;
    } finally {
        activeScenario = undefined;
        result.after = await snapshot().catch((error) => ({
            error: error.message,
        }));
        await page
            .screenshot({ path: path.join(output, `${name}.png`) })
            .catch(() => {});
        await fs.writeFile(
            path.join(output, "report.json"),
            JSON.stringify(report, null, 2)
        );
        console.log(`${result.status}: ${name}`);
    }
    if (result.status === "failed")
        throw new Error(`E2E scenario failed: ${name}`);
}

try {
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(vault, { recursive: true });
    if (!process.env.STASH_E2E_BUNDLE_DIR)
        execFileSync(process.execPath, ["esbuild.config.mjs", "production"], {
            cwd: root,
            stdio: "inherit",
        });
    const pluginDir = path.join(vault, ".obsidian/plugins/obsidian-git");
    await fs.mkdir(pluginDir, { recursive: true });
    for (const name of ["main.js", "manifest.json", "styles.css"])
        await fs.copyFile(path.join(bundle, name), path.join(pluginDir, name));
    report.pluginSha256 = createHash("sha256")
        .update(await fs.readFile(path.join(bundle, "main.js")))
        .digest("hex");
    report.versions.git = git(["--version"]);
    report.versions.playwright = JSON.parse(
        await fs.readFile(
            path.join(root, "node_modules/playwright-core/package.json"),
            "utf8"
        )
    ).version;
    await write(
        ".obsidian/community-plugins.json",
        JSON.stringify(["obsidian-git"])
    );
    await write(
        ".obsidian/core-plugins.json",
        JSON.stringify(["file-explorer", "command-palette"])
    );
    await write(
        ".obsidian/app.json",
        JSON.stringify({ livePreview: true, showUnsupportedFiles: true })
    );
    await write(
        ".obsidian/plugins/obsidian-git/data.json",
        JSON.stringify({
            autoSaveInterval: 0,
            autoPullInterval: 0,
            autoPushInterval: 0,
            autoPullOnBoot: false,
            showBranchStatusBar: false,
            changedFilesInStatusBar: true,
            refreshSourceControlTimer: 100,
            showedMobileNotice: true,
        })
    );
    await write(".gitignore", ".obsidian/\nignored.md\nnested/\nunborn/\n");
    await write("note.md", "base\n");
    await write("delete.md", "delete base\n");
    await write("binary.bin", Buffer.from([0, 1, 2, 255]));
    git(["init", "--initial-branch=main"]);
    git(["add", "."]);
    git(["commit", "-m", "fixture base"]);
    seed = git(["rev-parse", "HEAD"]);
    await fs.writeFile(
        path.join(profile, "obsidian.json"),
        JSON.stringify({
            vaults: {
                "stash-e2e": { path: vault, ts: Date.now(), open: true },
            },
            updateDisabled: true,
        })
    );
    const cache = path.join(
        os.homedir(),
        "Library/Application Support/obsidian"
    );
    const cached = await fs.readdir(cache).catch(() => []);
    const latest = cached
        .filter((name) => /^obsidian-\d+\.\d+\.\d+\.asar$/.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .at(-1);
    const appAsar =
        process.env.OBSIDIAN_APP_ASAR || (latest && path.join(cache, latest));
    if (appAsar)
        await fs.copyFile(appAsar, path.join(profile, path.basename(appAsar)));
    if (appAsar)
        report.appAsarSha256 = createHash("sha256")
            .update(await fs.readFile(appAsar))
            .digest("hex");
    const env = { ...gitEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
        executable,
        [
            `--user-data-dir=${profile}`,
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(
            () =>
                reject(
                    new Error(
                        "Obsidian did not expose its test debugging endpoint"
                    )
                ),
            30000
        );
        const inspect = (bytes) => {
            const text = bytes.toString();
            report.console.push({ type: "process", text });
            const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        };
        child.stdout.on("data", inspect);
        child.stderr.on("data", inspect);
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Obsidian exited during startup: ${code}`));
        });
    });
    electron = await chromium.connectOverCDP(endpoint);
    const context = electron.contexts()[0];
    page = context.pages()[0] || (await context.waitForEvent("page"));
    page.setDefaultTimeout(10000);
    page.on("console", (message) =>
        report.console.push({ type: message.type(), text: message.text() })
    );
    page.on("pageerror", (error) =>
        report.console.push({ type: "pageerror", text: error.message })
    );
    await page
        .getByRole("button", {
            name: "Trust author and enable plugins",
            exact: true,
        })
        .click();
    await page.waitForFunction(
        () => window.app?.plugins?.plugins?.["obsidian-git"]?.gitReady,
        undefined,
        { timeout: 30000 }
    );
    report.versions.obsidian = await page.evaluate(() => navigator.userAgent);

    await scenario("commands-and-empty-list", async () => {
        for (const id of [
            "stash-push",
            "stash-list",
            "stash-apply",
            "stash-pop",
            "stash-drop",
        ]) {
            assert.equal(
                await page.evaluate(
                    (id) =>
                        Boolean(
                            window.app.commands.commands[`obsidian-git:${id}`]
                        ),
                    id
                ),
                true,
                `${id} is not registered`
            );
        }
        await command("stash-list");
        await finished();
        assert.equal(git(["stash", "list"]), "");
        await page
            .getByText("No stashes found", { exact: false })
            .last()
            .waitFor();
    });

    await scenario("round-trip-with-index-and-untracked", async () => {
        await write("note.md", "staged\n");
        git(["add", "note.md"]);
        await write("note.md", "working\n");
        await write("new note ü.md", "new\n");
        await write("ignored.md", "ignored\n");
        await snapshot();
        await push("message with spaces ü --flag");
        assert.equal(git(["status", "--porcelain"]), "");
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "base\n"
        );
        assert.equal(
            await fs.readFile(path.join(vault, "ignored.md"), "utf8"),
            "ignored\n"
        );
        const listed = await snapshot();
        await command("stash-list");
        await page.locator(".prompt-input").last().fill("message with spaces");
        await captureOnce("stash-list-picker");
        await page
            .locator(".suggestion-item")
            .filter({ hasText: "message with spaces ü --flag" })
            .click();
        await finished();
        assert.deepEqual(await snapshot(), listed);
        await select("stash-apply", "message with spaces ü --flag", true);
        assert.equal(git(["show", ":note.md"]), "staged");
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "working\n"
        );
        assert.equal(
            await fs.readFile(path.join(vault, "new note ü.md"), "utf8"),
            "new\n"
        );
        assert.notEqual(git(["stash", "list"]), "");
    });

    await scenario("exclude-untracked-and-pop", async () => {
        await write("note.md", "shelved\n");
        await write("new.md", "keep\n");
        await push("E2E stash", false);
        assert.equal(
            await fs.readFile(path.join(vault, "new.md"), "utf8"),
            "keep\n"
        );
        await select("stash-pop");
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "shelved\n"
        );
        assert.equal(git(["stash", "list"]), "");
        assert.equal(git(["diff", "--cached", "--name-only"]), "");
    });

    await scenario("binary-deletion-rename-and-staged-addition", async () => {
        git(["mv", "note.md", "renamed ü.md"]);
        await fs.rm(path.join(vault, "delete.md"));
        await write("binary.bin", Buffer.from([0, 4, 128, 255, 10]));
        await write("added.md", "added\n");
        git(["add", "added.md"]);
        const before = await snapshot();
        await push();
        await select("stash-apply", "E2E stash", true);
        const after = await snapshot();
        assert.deepEqual(after.files, before.files);
        assert.equal(after.index, before.index);
    });

    await scenario("cancel-create-and-drop-confirmation", async () => {
        await write("note.md", "edits\n");
        await command("stash-push");
        await page.getByPlaceholder("Optional stash message").waitFor();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await finished();
        assert.equal(git(["stash", "list"]), "");
        await push();
        const before = git(["stash", "list"]);
        await command("stash-apply");
        await page.locator(".prompt-input").last().waitFor();
        await page.keyboard.press("Escape");
        await finished();
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "base\n"
        );
        await select("stash-drop");
        await captureOnce("stash-drop-confirmation");
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await finished();
        assert.equal(git(["stash", "list"]), before);
        await select("stash-drop");
        await page
            .getByRole("button", { name: "Drop stash", exact: true })
            .click();
        await finished();
        assert.equal(git(["stash", "list"]), "");
    });

    await scenario("clean-tree-no-op", async () => {
        await push();
        assert.equal(git(["stash", "list"]), "");
        await page
            .getByText("Nothing to stash", { exact: false })
            .last()
            .waitFor();
    });

    await scenario("conflicting-pop-retains-stash", async () => {
        await write("note.md", "stashed\n");
        await push();
        const before = git(["rev-parse", "refs/stash"]);
        await write("note.md", "upstream\n");
        git(["add", "note.md"]);
        git(["commit", "-m", "upstream change"]);
        await select("stash-pop");
        assert.equal(git(["rev-parse", "refs/stash"]), before);
        assert.equal(
            git(["diff", "--name-only", "--diff-filter=U"]),
            "note.md"
        );
        assert.match(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            /<<<<<<<.*[\s\S]*upstream[\s\S]*stashed/
        );
        assert.deepEqual(
            await page.evaluate(
                () =>
                    window.app.plugins.plugins["obsidian-git"].cachedStatus
                        .conflicted
            ),
            ["note.md"]
        );
    });

    await scenario("overlapping-edits-preserved", async () => {
        await write("note.md", "stashed\n");
        await push();
        await write("note.md", "current\n");
        await select("stash-apply");
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "current\n"
        );
        assert.notEqual(git(["stash", "list"]), "");
    });

    await scenario("stale-picker-selection-rejected", async () => {
        await write("note.md", "original\n");
        await push("original stash");
        await command("stash-apply");
        await page.locator(".prompt-input").last().waitFor();
        await write("note.md", "external\n");
        git(["stash", "push", "-m", "external stash"]);
        await page
            .locator(".suggestion-item")
            .filter({ hasText: "original stash" })
            .click();
        await finished();
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "base\n"
        );
        assert.equal(
            git(["stash", "list", "--format=%H"]).split("\n").length,
            2
        );
        await page
            .getByText("Stash list changed", { exact: false })
            .last()
            .waitFor();
    });

    await scenario("pop-drop-failure-retains-restored-copy", async () => {
        await write("note.md", "shelved\n");
        await push();
        await write(".git/refs/stash.lock", "controlled E2E lock\n");
        await select("stash-pop");
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "shelved\n"
        );
        assert.notEqual(git(["stash", "list"]), "");
        await page
            .getByText("Changes restored; stash retained", { exact: false })
            .last()
            .waitFor();
    });

    await scenario("unfinished-merge-and-rebase-rejected", async () => {
        await write("note.md", "edits\n");
        await write(".git/MERGE_HEAD", `${seed}\n`);
        await push();
        assert.equal(git(["stash", "list"]), "");
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "edits\n"
        );
        await fs.rm(path.join(vault, ".git/MERGE_HEAD"));
        await fs.mkdir(path.join(vault, ".git/rebase-merge"));
        await push();
        assert.equal(git(["stash", "list"]), "");
    });

    await scenario("open-editor-pending-save-round-trip", async () => {
        await page.evaluate(async () => {
            const file = window.app.vault.getAbstractFileByPath("note.md");
            await window.app.workspace.getLeaf(false).openFile(file);
            const view = window.app.workspace.activeLeaf.view;
            view.editor.setValue("pending editor edits\n");
            view.requestSave();
        });
        await push();
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "base\n"
        );
        await page.waitForFunction(
            () =>
                window.app.workspace.activeLeaf.view?.editor.getValue() ===
                "base\n"
        );
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "base\n"
        );
        await select("stash-apply");
        assert.equal(
            await fs.readFile(path.join(vault, "note.md"), "utf8"),
            "pending editor edits\n"
        );
        await page.waitForFunction(
            () =>
                window.app.workspace.activeLeaf.view?.editor.getValue() ===
                "pending editor edits\n"
        );
    });

    await scenario("nested-repository-and-missing-head", async () => {
        const nested = path.join(vault, "nested");
        await write("note.md", "nested base\n", nested);
        git(["init", "--initial-branch=main"], nested);
        git(["add", "."], nested);
        git(["commit", "-m", "nested base"], nested);
        await setBasePath("nested");
        await write("note.md", "nested edits\n", nested);
        await push();
        assert.equal(
            await fs.readFile(path.join(nested, "note.md"), "utf8"),
            "nested base\n"
        );
        await select("stash-pop");
        assert.equal(
            await fs.readFile(path.join(nested, "note.md"), "utf8"),
            "nested edits\n"
        );
        const unborn = path.join(vault, "unborn");
        await write("note.md", "unborn edits\n", unborn);
        git(["init", "--initial-branch=main"], unborn);
        await setBasePath("unborn");
        await push();
        assert.equal(git(["stash", "list"], unborn), "");
        assert.equal(
            await fs.readFile(path.join(unborn, "note.md"), "utf8"),
            "unborn edits\n"
        );
        await page
            .getByText("Create an initial commit", { exact: false })
            .last()
            .waitFor();
    });

    await scenario("queue-and-backend-gates", async () => {
        await write("note.md", "queued edits\n");
        await command("stash-push");
        await page.getByPlaceholder("Optional stash message").waitFor();
        await page.evaluate(() => {
            const plugin = window.app.plugins.plugins["obsidian-git"];
            window.stashQueueEvidence = [];
            plugin.promiseQueue.addTask(async () => {
                window.stashQueueEvidence.push(
                    (await plugin.gitManager.listStashes()).length
                );
            });
        });
        assert.deepEqual(
            await page.evaluate(() => window.stashQueueEvidence),
            []
        );
        await page
            .getByRole("button", { name: "Stash changes", exact: true })
            .click();
        await finished();
        assert.deepEqual(await page.evaluate(() => window.stashQueueEvidence), [
            1,
        ]);
        const gates = await page.evaluate(() => {
            const plugin = window.app.plugins.plugins["obsidian-git"];
            const manager = plugin.gitManager;
            try {
                plugin.gitManager = null;
                return [
                    "stash-push",
                    "stash-list",
                    "stash-apply",
                    "stash-pop",
                    "stash-drop",
                ].map((id) =>
                    window.app.commands.commands[
                        `obsidian-git:${id}`
                    ].checkCallback(true)
                );
            } finally {
                plugin.gitManager = manager;
            }
        });
        assert.deepEqual(gates, [false, false, false, false, false]);
    });

    await scenario("parent-repository-rejected", async () => {
        const oldGit = path.join(vault, ".git");
        const parentGit = path.join(output, ".git");
        await fs.rename(oldGit, parentGit);
        try {
            await setBasePath("");
            const before = git(["status", "--porcelain"], output);
            await push();
            assert.equal(git(["status", "--porcelain"], output), before);
            await page
                .getByText("Stash requires a repository inside the vault", {
                    exact: false,
                })
                .last()
                .waitFor();
        } finally {
            await fs.rename(parentGit, oldGit);
            await setBasePath("");
        }
    });
} catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
    console.error(error.message);
    if (page)
        await page
            .screenshot({ path: path.join(output, "failure.png") })
            .catch(() => {});
} finally {
    if (electron) await electron.close().catch(() => {});
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await fs.mkdir(output, { recursive: true });
    report.passed = !process.exitCode;
    await fs.writeFile(
        path.join(output, "report.json"),
        JSON.stringify(report, null, 2)
    );
    await fs.copyFile(
        fileURLToPath(import.meta.url),
        path.join(output, "replay.mjs")
    );
    for (const name of ["main.js", "manifest.json", "styles.css"])
        await fs
            .copyFile(path.join(bundle, name), path.join(output, name))
            .catch(() => {});
    for (const name of ["package.json", "pnpm-lock.yaml"])
        await fs
            .copyFile(path.join(root, name), path.join(output, name))
            .catch(() => {});
    await fs.writeFile(
        path.join(output, "README.md"),
        [
            "# Stash E2E evidence",
            "",
            "Run from a checkout of this fork with Node >=24, pnpm >=11, Git, and desktop Obsidian installed. Run `pnpm install --frozen-lockfile` first.",
            "",
            "Extract this archive under the checkout's `artifacts/replay/`. Verify the evidence from that directory:",
            "",
            "```sh",
            "shasum -a 256 -c checksums.sha256",
            "```",
            "",
            "From the checkout root, rerun the exact archived plugin and fixture script:",
            "",
            "```sh",
            'STASH_E2E_PROJECT_ROOT="$PWD" STASH_E2E_BUNDLE_DIR="$PWD/artifacts/replay" node artifacts/replay/replay.mjs',
            "```",
            "",
            "The replay creates a new disposable vault/profile and a new evidence archive. It skips rebuilding the archived plugin. Compare `pluginSha256` and scenario results in both reports. Set `OBSIDIAN_EXECUTABLE` and `OBSIDIAN_APP_ASAR` when overriding the default macOS launcher/app archive. The runner was verified on macOS; other desktop launchers have not been verified.",
            "",
            "`report.json` includes assertions, before/after and intermediate Git/file snapshots, versions, and logs. `replay.mjs` contains fixture inputs and expected results. Screenshots show dialogs and scenario outcomes. The archive excludes the app profile and disposable vault; replay recreates them. No personal vault is used.",
            "",
        ].join("\n")
    );
    const evidenceFiles = (await fs.readdir(output)).sort();
    const checksums = [];
    for (const name of evidenceFiles) {
        const info = await fs.stat(path.join(output, name));
        if (!info.isFile()) continue;
        const hash = createHash("sha256")
            .update(await fs.readFile(path.join(output, name)))
            .digest("hex");
        checksums.push(`${hash}  ${name}`);
    }
    await fs.writeFile(
        path.join(output, "checksums.sha256"),
        checksums.join("\n") + "\n"
    );
    execFileSync("tar", [
        "-czf",
        `${output}.tar.gz`,
        "--exclude=profile",
        "--exclude=vault",
        "-C",
        output,
        ".",
    ]);
    console.log(`Evidence: ${output}/report.json`);
    console.log(`Archive: ${output}.tar.gz`);
}
process.exit(process.exitCode || 0);
