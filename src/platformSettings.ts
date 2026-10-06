import * as vscode from 'vscode';
import { allPlatformKeys, currentPlatform, deepEqual, platformBlock, Settings } from './core/layers';

/**
 * User settings per operating system.
 *
 *   "settingsLayers.platform": {
 *       "windows": { "terminal.integrated.defaultProfile.windows": "Git Bash", "editor.fontSize": 13 },
 *       "macos":   { "editor.fontSize": 15 }
 *   }
 *
 * This one setting syncs to every machine with Settings Sync. On each machine the block for its
 * system is written to the user settings, and every key named in any block is added to
 * "settingsSync.ignoredSettings", so the machines stop overwriting each other.
 */
const APPLIED_KEY = 'settingsLayers.platformApplied';
const IGNORED_KEY = 'settingsLayers.platformIgnored';

export class PlatformSettings implements vscode.Disposable {
    private readonly disposable: vscode.Disposable;
    private running: Promise<void> = Promise.resolve();

    constructor(private readonly state: vscode.Memento) {
        this.disposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('settingsLayers.platform')) { void this.apply(); }
        });
    }

    apply(): Promise<void> {
        this.running = this.running.then(() => this.applyNow()).catch(err => {
            void vscode.window.showErrorMessage(`Settings Layers: ${err instanceof Error ? err.message : String(err)}`);
        });
        return this.running;
    }

    private async applyNow(): Promise<void> {
        const value = vscode.workspace.getConfiguration('settingsLayers').inspect('platform')?.globalValue;
        const block = platformBlock(value, currentPlatform());
        const applied = this.state.get<Settings>(APPLIED_KEY, {});
        const root = vscode.workspace.getConfiguration();

        // Keys no longer in this system's block go back to their default, unless changed since
        for (const [key, was] of Object.entries(applied)) {
            if (key in block) { continue; }
            if (deepEqual(root.inspect(key)?.globalValue, was)) {
                await root.update(key, undefined, vscode.ConfigurationTarget.Global);
            }
        }
        for (const [key, want] of Object.entries(block)) {
            if (!deepEqual(root.inspect(key)?.globalValue, want)) {
                await root.update(key, want, vscode.ConfigurationTarget.Global);
            }
        }
        await this.state.update(APPLIED_KEY, block);

        // Keep every per-system key out of Settings Sync
        const keys = allPlatformKeys(value);
        const addedBefore = this.state.get<string[]>(IGNORED_KEY, []);
        const ignored = (root.inspect<string[]>('settingsSync.ignoredSettings')?.globalValue ?? []).slice();
        const next = ignored.filter(k => keys.includes(k) || !addedBefore.includes(k));
        const added = addedBefore.filter(k => keys.includes(k));
        for (const k of keys) {
            if (!next.includes(k)) {
                next.push(k);
                added.push(k);
            }
        }
        if (!deepEqual(next, ignored)) {
            await root.update('settingsSync.ignoredSettings', next, vscode.ConfigurationTarget.Global);
        }
        await this.state.update(IGNORED_KEY, [...new Set(added)]);
    }

    dispose(): void {
        this.disposable.dispose();
    }
}
