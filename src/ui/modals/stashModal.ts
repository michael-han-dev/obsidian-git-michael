import { FuzzySuggestModal, Modal, Setting } from "obsidian";
import type ObsidianGit from "src/main";
import type { StashCreateOptions, StashEntry } from "src/types";

export type StashSelection = { entry: StashEntry; restoreIndex: boolean };

export class StashCreateModal extends Modal {
    private resolve?: (value: StashCreateOptions | undefined) => void;

    openAndGetResult(): Promise<StashCreateOptions | undefined> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen(): void {
        this.setTitle("Stash changes");
        this.titleEl.setAttribute("role", "heading");
        this.titleEl.setAttribute("aria-level", "1");
        let message = "";
        new Setting(this.contentEl).setName("Message").addText((text) => {
            text.setPlaceholder("Optional stash message").onChange((value) => {
                message = value;
            });
        });
        const label = this.contentEl.createEl("label");
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = true;
        label.createSpan({ text: "Include untracked files" });
        this.contentEl.createEl("p", {
            text: "Stashed changes are saved locally. Included new files disappear from the vault until restored. Ignored files are left unchanged.",
        });
        const buttons = new Setting(this.contentEl);
        buttons.addButton((button) =>
            button.setButtonText("Cancel").onClick(() => this.close())
        );
        buttons.addButton((button) =>
            button
                .setButtonText("Stash changes")
                .setCta()
                .onClick(() => {
                    this.resolve?.({
                        message,
                        includeUntracked: checkbox.checked,
                    });
                    this.resolve = undefined;
                    this.close();
                })
        );
    }

    onClose(): void {
        this.resolve?.(undefined);
        this.resolve = undefined;
        this.contentEl.empty();
    }
}

export class StashSelectModal extends FuzzySuggestModal<StashEntry> {
    private resolve?: (value: StashSelection | undefined) => void;
    private restoreIndex = false;

    constructor(
        plugin: ObsidianGit,
        private readonly entries: StashEntry[],
        action: string,
        restoreOptions = false
    ) {
        super(plugin.app);
        this.setPlaceholder(`${action}: select a stash`);
        if (restoreOptions) {
            const label = this.contentEl.createEl("label");
            const checkbox = label.createEl("input", { type: "checkbox" });
            checkbox.addEventListener("change", () => {
                this.restoreIndex = checkbox.checked;
            });
            label.createSpan({ text: "Restore staging" });
            this.resultContainerEl.before(label);
        }
    }

    getItems(): StashEntry[] {
        return this.entries;
    }

    getItemText(entry: StashEntry): string {
        return `${entry.ref}: ${entry.message} (${entry.date})`;
    }

    onChooseItem(entry: StashEntry, _: MouseEvent | KeyboardEvent): void {
        this.resolve?.({ entry, restoreIndex: this.restoreIndex });
        this.resolve = undefined;
    }

    openAndGetResult(): Promise<StashSelection | undefined> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onClose(): void {
        queueMicrotask(() => {
            this.resolve?.(undefined);
            this.resolve = undefined;
        });
    }
}

export class StashDropModal extends Modal {
    private resolve?: (value: boolean) => void;

    constructor(
        plugin: ObsidianGit,
        private readonly entry: StashEntry
    ) {
        super(plugin.app);
    }

    openAndGetResult(): Promise<boolean> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen(): void {
        this.setTitle("Drop stash");
        this.contentEl.createEl("p", {
            text: `Delete ${this.entry.ref}: ${this.entry.message}? This removes the saved copy without restoring its changes.`,
        });
        const buttons = new Setting(this.contentEl);
        buttons.addButton((button) =>
            button.setButtonText("Cancel").onClick(() => this.close())
        );
        buttons.addButton((button) =>
            button
                .setButtonText("Drop stash")
                .setWarning()
                .onClick(() => {
                    this.resolve?.(true);
                    this.resolve = undefined;
                    this.close();
                })
        );
    }

    onClose(): void {
        this.resolve?.(false);
        this.resolve = undefined;
        this.contentEl.empty();
    }
}
