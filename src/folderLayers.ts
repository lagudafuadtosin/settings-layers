import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    applyToLocal,
    buildSettings,
    BuildResult,
    currentPlatform,
    findChanges,
    GENERATED_HEADER,
    parseSettings,
    render,
    Settings,
} from './core/layers';
import { readText, resolveExtends } from './core/resolve';

export const SHARED = 'settings.shared.json';
export const LOCAL = 'settings.local.json';
export const OUTPUT = 'settings.json';

interface LastWrite {
    text: string;
    settings: Settings;
}

/**
 * Keeps one workspace folder's .vscode/settings.json in step with its layers, and saves edits
 * made to settings.json (by hand or in the Settings editor) back into settings.local.json.
 */
export class FolderLayers implements vscode.Disposable {
    readonly vscodeDir: string;
    readonly sharedPath: string;
    readonly localPath: string;
    readonly outputPath: string;

    /** The last build, for hovers and the "where does this come from" command. */
    lastBuild: BuildResult | null = null;

    private readonly disposables: vscode.Disposable[] = [];
    private extendsWatchers: vscode.Disposable[] = [];
    private watchedExtends = '';
    private queue: Promise<void> = Promise.resolve();
    private timer: NodeJS.Timeout | undefined;
    /** Set when someone chose "Not now" for this folder's existing settings.json. */
    private paused = false;

    constructor(
        readonly folder: vscode.WorkspaceFolder,
        private readonly state: vscode.Memento,
        private readonly diagnostics: vscode.DiagnosticCollection,
        private readonly onBuilt: () => void
    ) {
        this.vscodeDir = path.join(folder.uri.fsPath, '.vscode');
        this.sharedPath = path.join(this.vscodeDir, SHARED);
        this.localPath = path.join(this.vscodeDir, LOCAL);
        this.outputPath = path.join(this.vscodeDir, OUTPUT);

        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.vscode/settings*.json'));
        watcher.onDidChange(() => this.schedule());
        watcher.onDidCreate(() => this.schedule());
        watcher.onDidDelete(() => this.schedule());
        this.disposables.push(watcher);
    }

    get active(): boolean {
        return fs.existsSync(this.sharedPath) || fs.existsSync(this.localPath);
    }

    /** Runs a sync soon, so a burst of file events turns into one rebuild. */
    schedule(): void {
        if (this.timer) { clearTimeout(this.timer); }
        this.timer = setTimeout(() => { void this.sync(); }, 150);
    }

    /** Runs a sync after any sync already in progress. */
    sync(): Promise<void> {
        this.queue = this.queue.then(() => this.syncNow()).catch(err => {
            void vscode.window.showErrorMessage(`Settings Layers: ${err instanceof Error ? err.message : String(err)}`);
        });
        return this.queue;
    }

    resume(): void {
        this.paused = false;
    }

    private get stateKey(): string {
        return `settingsLayers.last:${this.outputPath.toLowerCase()}`;
    }

    private async syncNow(): Promise<void> {
        let sharedText = readText(this.sharedPath);
        let localText = readText(this.localPath);
        if (sharedText === null && localText === null) {
            this.lastBuild = null;
            this.diagnostics.delete(vscode.Uri.file(this.sharedPath));
            this.diagnostics.delete(vscode.Uri.file(this.localPath));
            this.watchExtends([]);
            this.onBuilt();
            return;
        }
        if (this.paused) { return; }

        const outputText = readText(this.outputPath);
        const last = this.state.get<LastWrite>(this.stateKey);

        // 1. Edits made to settings.json since we wrote it go into settings.local.json
        if (outputText !== null && last && outputText !== last.text) {
            const current = this.parseOutput(outputText);
            if (current === null) { return; }  // half-written or broken: wait for the next save
            const change = findChanges(last.settings, current);
            if (Object.keys(change.set).length > 0 || change.removed.length > 0) {
                localText = applyToLocal(localText, change);
                await this.write(this.localPath, localText);
                this.reportKept(change.removed, sharedText, localText);
            }
        } else if (outputText !== null && !last && !outputText.startsWith(GENERATED_HEADER.split('\n')[0])) {
            // 2. First time here, and settings.json was written by someone else
            const current = this.parseOutput(outputText);
            if (current === null) { return; }
            const built = this.build(sharedText, localText);
            const change = findChanges(built.settings, current);
            change.removed = [];
            const count = Object.keys(change.set).length;
            if (count > 0) {
                const move = `Move to ${LOCAL}`;
                const answer = await vscode.window.showWarningMessage(
                    `${this.folder.name}: settings.json has ${count} setting${count === 1 ? '' : 's'} that ${count === 1 ? 'is' : 'are'} not in your layers. ` +
                    `Settings Layers rebuilds settings.json from ${SHARED} and ${LOCAL}.`,
                    move,
                    'Not now'
                );
                if (answer !== move) {
                    this.paused = true;
                    return;
                }
                localText = applyToLocal(localText, change);
                await this.write(this.localPath, localText);
            }
        }

        // 3. Rebuild settings.json from the layers
        sharedText = readText(this.sharedPath);
        const result = this.build(sharedText, localText);
        this.lastBuild = result;
        this.showErrors(result);
        this.watchExtends(result.files.filter(f => f !== this.sharedPath && f !== this.localPath));

        const text = render(result.settings);
        if (text !== outputText) {
            await this.write(this.outputPath, text);
        }
        await this.state.update(this.stateKey, { text, settings: result.settings } satisfies LastWrite);
        this.onBuilt();
    }

    build(sharedText: string | null, localText: string | null): BuildResult {
        return buildSettings(
            { path: this.sharedPath, text: sharedText },
            { path: this.localPath, text: localText },
            currentPlatform(),
            readText,
            { resolve: resolveExtends }
        );
    }

    private parseOutput(text: string): Settings | null {
        const errors: { file: string; message: string }[] = [];
        const settings = parseSettings(text, this.outputPath, errors);
        return errors.length > 0 ? null : settings;
    }

    /** A setting reset in the Settings editor that a shared layer still sets keeps the shared value. */
    private reportKept(removed: string[], sharedText: string | null, localText: string): void {
        if (removed.length === 0) { return; }
        const kept = removed.filter(key => key in this.build(sharedText, localText).settings);
        if (kept.length > 0) {
            vscode.window.setStatusBarMessage(
                `Settings Layers: ${kept.join(', ')} ${kept.length === 1 ? 'comes' : 'come'} from the shared settings, so the shared value is back. Set your own value in ${LOCAL}.`,
                8000
            );
        }
    }

    private showErrors(result: BuildResult): void {
        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (const e of result.errors) {
            const list = byFile.get(e.file) ?? [];
            const offsetMatch = /at offset (\d+)$/.exec(e.message);
            let range = new vscode.Range(0, 0, 0, 0);
            if (offsetMatch) {
                const text = readText(e.file) ?? '';
                const before = text.slice(0, Number(offsetMatch[1])).split(/\r?\n/);
                const line = before.length - 1;
                const col = before[line].length;
                range = new vscode.Range(line, col, line, col + 1);
            } else {
                const text = readText(e.file) ?? '';
                const at = text.indexOf('@extends');
                if (at !== -1) {
                    const before = text.slice(0, at).split(/\r?\n/);
                    range = new vscode.Range(before.length - 1, before[before.length - 1].length, before.length - 1, before[before.length - 1].length + 8);
                }
            }
            const d = new vscode.Diagnostic(range, e.message, vscode.DiagnosticSeverity.Error);
            d.source = 'Settings Layers';
            list.push(d);
            byFile.set(e.file, list);
        }
        for (const file of [this.sharedPath, this.localPath, ...result.files]) {
            this.diagnostics.set(vscode.Uri.file(file), byFile.get(file) ?? []);
        }
        for (const [file, list] of byFile) {
            this.diagnostics.set(vscode.Uri.file(file), list);
        }
    }

    /** Files named by "@extends" may live outside the folder (node_modules, a parent folder). */
    private watchExtends(files: string[]): void {
        const key = files.join('|');
        if (key === this.watchedExtends) { return; }
        this.watchedExtends = key;
        this.extendsWatchers.forEach(d => d.dispose());
        this.extendsWatchers = files.map(file => {
            const w = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file))
            );
            w.onDidChange(() => this.schedule());
            w.onDidCreate(() => this.schedule());
            w.onDidDelete(() => this.schedule());
            return w;
        });
    }

    private async write(file: string, text: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, text, 'utf8');
    }

    dispose(): void {
        if (this.timer) { clearTimeout(this.timer); }
        this.extendsWatchers.forEach(d => d.dispose());
        this.disposables.forEach(d => d.dispose());
    }
}
