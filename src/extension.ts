import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findNodeAtLocation, getLocation, parseTree } from 'jsonc-parser';
import { folderIgnored, missingIgnoreLines, withIgnoreLines } from './core/gitignore';
import { PLATFORM_KEYS } from './core/layers';
import { readText } from './core/resolve';
import { FolderLayers, LOCAL, OUTPUT, SHARED } from './folderLayers';
import { PlatformSettings } from './platformSettings';

const folders = new Map<string, FolderLayers>();

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection('settingsLayers');
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
    statusBar.command = 'settingsLayers.explain';
    context.subscriptions.push(diagnostics, statusBar);

    const refreshStatus = () => {
        const active = [...folders.values()].filter(f => f.lastBuild);
        if (active.length === 0) {
            statusBar.hide();
            return;
        }
        const errors = active.reduce((n, f) => n + (f.lastBuild?.errors.length ?? 0), 0);
        statusBar.text = errors > 0 ? '$(warning) Layers' : '$(layers) Layers';
        statusBar.tooltip = errors > 0
            ? `Settings Layers: ${errors} problem${errors === 1 ? '' : 's'} in the layer files`
            : 'Settings Layers: settings.json is built from your layers. Click to see where each setting comes from.';
        statusBar.show();
    };

    const addFolder = (folder: vscode.WorkspaceFolder) => {
        const layers = new FolderLayers(folder, context.workspaceState, diagnostics, refreshStatus);
        folders.set(folder.uri.toString(), layers);
        if (layers.active) { void layers.sync(); }
    };
    (vscode.workspace.workspaceFolders ?? []).forEach(addFolder);
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(e => {
        for (const f of e.removed) {
            folders.get(f.uri.toString())?.dispose();
            folders.delete(f.uri.toString());
        }
        e.added.forEach(addFolder);
        refreshStatus();
    }));
    context.subscriptions.push({ dispose: () => folders.forEach(f => f.dispose()) });

    const platform = new PlatformSettings(context.globalState);
    context.subscriptions.push(platform);
    void platform.apply();

    context.subscriptions.push(
        vscode.commands.registerCommand('settingsLayers.init', () => initFolder()),
        vscode.commands.registerCommand('settingsLayers.rebuild', async () => {
            for (const f of folders.values()) {
                f.resume();
                if (f.active) { await f.sync(); }
            }
        }),
        vscode.commands.registerCommand('settingsLayers.explain', () => explain()),
        vscode.commands.registerCommand('settingsLayers.openShared', () => openLayer(SHARED)),
        vscode.commands.registerCommand('settingsLayers.openLocal', () => openLayer(LOCAL)),
        vscode.languages.registerHoverProvider(
            { scheme: 'file', pattern: '**/.vscode/settings{,.shared,.local}.json' },
            { provideHover: (doc, pos) => hover(doc, pos) }
        )
    );
}

export function deactivate(): void {
    // Watchers are disposed with the extension's subscriptions
}

/** The FolderLayers for a file inside one of the open folders. */
function layersFor(uri: vscode.Uri): FolderLayers | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? folders.get(folder.uri.toString()) : undefined;
}

async function pickFolder(placeHolder: string): Promise<FolderLayers | undefined> {
    const list = [...folders.values()];
    if (list.length <= 1) { return list[0]; }
    const pick = await vscode.window.showQuickPick(
        list.map(f => ({ label: f.folder.name, description: f.active ? 'layered' : '', layers: f })),
        { placeHolder }
    );
    return pick?.layers;
}

async function initFolder(): Promise<void> {
    const layers = await pickFolder('Set up settings layers in which folder?');
    if (!layers) {
        void vscode.window.showInformationMessage('Settings Layers: open a folder first.');
        return;
    }
    await fs.promises.mkdir(layers.vscodeDir, { recursive: true });

    if (!fs.existsSync(layers.sharedPath)) {
        const existing = readText(layers.outputPath);
        let sharedBody = '{\n}\n';
        let localBody = '{\n}\n';
        if (existing !== null && existing.trim() !== '' && existing.trim() !== '{}') {
            const team = 'Shared with the team';
            const mine = 'Only for me';
            const answer = await vscode.window.showQuickPick([team, mine], {
                placeHolder: `Where should the settings already in ${OUTPUT} go?`,
            });
            if (!answer) { return; }
            if (answer === team) { sharedBody = existing; } else { localBody = existing; }
        }
        await fs.promises.writeFile(layers.sharedPath,
            `// Team settings for this folder. Commit this file.\n// Settings Layers builds settings.json from this file and ${LOCAL}.\n${sharedBody}`, 'utf8');
        if (!fs.existsSync(layers.localPath)) {
            await fs.promises.writeFile(layers.localPath,
                `// Your own settings for this folder. Not committed. These win over ${SHARED}.\n${localBody}`, 'utf8');
        }
    } else if (!fs.existsSync(layers.localPath)) {
        await fs.promises.writeFile(layers.localPath,
            `// Your own settings for this folder. Not committed. These win over ${SHARED}.\n{\n}\n`, 'utf8');
    }

    await offerGitignore(layers);
    layers.resume();
    await layers.sync();
    await vscode.window.showTextDocument(vscode.Uri.file(layers.sharedPath));
}

async function offerGitignore(layers: FolderLayers): Promise<void> {
    const root = layers.folder.uri.fsPath;
    const gitignorePath = path.join(root, '.gitignore');
    const text = readText(gitignorePath);
    if (folderIgnored(text)) {
        void vscode.window.showWarningMessage(
            `.gitignore ignores the whole .vscode folder, so ${SHARED} will not be committed. ` +
            `Change that line to ".vscode/*" and add "!.vscode/${SHARED}".`
        );
        return;
    }
    const missing = missingIgnoreLines(text);
    if (missing.length > 0) {
        const add = 'Add to .gitignore';
        const answer = await vscode.window.showInformationMessage(
            `Keep the generated settings.json and your ${LOCAL} out of git? This adds: ${missing.join(', ')}`,
            add,
            'No'
        );
        if (answer === add) {
            await fs.promises.writeFile(gitignorePath, withIgnoreLines(text, missing), 'utf8');
        }
    }
    if (await isTracked(root, `.vscode/${OUTPUT}`)) {
        const copy = 'Copy command';
        const command = `git rm --cached .vscode/${OUTPUT}`;
        const answer = await vscode.window.showInformationMessage(
            `.vscode/${OUTPUT} is still tracked by git. To stop tracking it (the file stays on disk), run: ${command}`,
            copy
        );
        if (answer === copy) { await vscode.env.clipboard.writeText(command); }
    }
}

function isTracked(cwd: string, file: string): Promise<boolean> {
    return new Promise(resolve => {
        execFile('git', ['ls-files', '--error-unmatch', file], { cwd }, err => resolve(!err));
    });
}

async function openLayer(name: string): Promise<void> {
    const layers = await pickFolder(`Open ${name} in which folder?`);
    if (!layers) { return; }
    const file = name === SHARED ? layers.sharedPath : layers.localPath;
    if (!fs.existsSync(file)) {
        const create = 'Set up layers';
        const answer = await vscode.window.showInformationMessage(`${name} does not exist yet in ${layers.folder.name}.`, create);
        if (answer === create) { await vscode.commands.executeCommand('settingsLayers.init'); }
        return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
}

function short(layers: FolderLayers, file: string): string {
    const rel = path.relative(layers.vscodeDir, file);
    return rel.startsWith('..') ? path.relative(layers.folder.uri.fsPath, file) || file : rel;
}

/** Lists every setting with the layer it comes from, and opens that line. */
async function explain(): Promise<void> {
    const layers = await pickFolder('Show where settings come from in which folder?');
    if (!layers?.lastBuild) {
        void vscode.window.showInformationMessage(`Settings Layers: no ${SHARED} or ${LOCAL} in this folder. Run "Settings Layers: Set Up Layers" first.`);
        return;
    }
    const build = layers.lastBuild;
    const items = [...build.origins.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, files]) => ({
            label: key,
            description: short(layers, files[files.length - 1]),
            detail: files.length > 1
                ? `Set in ${files.map(f => short(layers, f)).join(', then ')}. The last one wins.`
                : undefined,
            key,
            file: files[files.length - 1],
        }));
    if (build.errors.length > 0) {
        void vscode.window.showWarningMessage(`Settings Layers: ${build.errors.map(e => `${short(layers, e.file)} ${e.message}`).join('; ')}`);
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Each setting and the layer it comes from', matchOnDescription: true });
    if (!pick) { return; }
    await revealKey(pick.file, pick.key);
}

async function revealKey(file: string, key: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const tree = parseTree(doc.getText(), [], { allowTrailingComma: true });
    let node = tree && findNodeAtLocation(tree, [key]);
    if (!node && tree) {
        for (const block of Object.values(PLATFORM_KEYS)) {
            node = findNodeAtLocation(tree, [block, key]);
            if (node) { break; }
        }
    }
    const editor = await vscode.window.showTextDocument(doc);
    if (node?.parent) {
        const start = doc.positionAt(node.parent.offset);
        editor.selection = new vscode.Selection(start, doc.positionAt(node.parent.offset + node.parent.length));
        editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.InCenter);
    }
}

function hover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const layers = layersFor(doc.uri);
    const build = layers?.lastBuild;
    if (!layers || !build) { return undefined; }
    const location = getLocation(doc.getText(), doc.offsetAt(pos));
    let key = location.path[0];
    if (typeof key === 'string' && Object.values(PLATFORM_KEYS).includes(key) && typeof location.path[1] === 'string') {
        key = location.path[1];
    }
    if (typeof key !== 'string' || key === '@extends' || Object.values(PLATFORM_KEYS).includes(key)) { return undefined; }
    const files = build.origins.get(key);
    const here = doc.uri.fsPath;
    const md = new vscode.MarkdownString();
    if (!files) {
        if (here === layers.outputPath) { return undefined; }
        md.appendMarkdown('**Settings Layers:** not used on this system');
        return new vscode.Hover(md);
    }
    const winner = files[files.length - 1];
    const chain = files.map(f => `\`${short(layers, f)}\``).join(' → ');
    if (here === layers.outputPath) {
        md.appendMarkdown(`**Settings Layers:** from ${chain}`);
    } else if (path.resolve(winner) === path.resolve(here)) {
        md.appendMarkdown(files.length > 1 ? `**Settings Layers:** this value wins (${chain})` : '**Settings Layers:** this value is used');
    } else {
        md.appendMarkdown(`**Settings Layers:** overridden by \`${short(layers, winner)}\``);
    }
    return new vscode.Hover(md);
}
