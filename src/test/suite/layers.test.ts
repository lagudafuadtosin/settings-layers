import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { currentPlatform, GENERATED_HEADER, parseSettings, PLATFORM_KEYS } from '../../core/layers';

const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const file = (name: string) => path.join(root(), '.vscode', name);
const read = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : null);
const json = (name: string) => parseSettings(read(name) ?? '', name, []);
const write = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), text, 'utf8');
};
const block = PLATFORM_KEYS[currentPlatform()];

async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (check()) { return; }
        await new Promise(r => setTimeout(r, 100));
    }
    assert.fail(`timed out waiting for ${what}`);
}

suite('Settings Layers (VS Code Integration)', () => {
    suiteSetup(async () => {
        write('settings.shared.json', `// team\n{\n    "editor.tabSize": 4,\n    "files.exclude": { "**/dist": true },\n    "${block}": { "editor.rulers": [100] }\n}\n`);
        write('settings.local.json', '// mine\n{\n    "editor.tabSize": 2\n}\n');
        await vscode.extensions.getExtension('lagudafuadtosin.settings-layers')!.activate();
        await vscode.commands.executeCommand('settingsLayers.rebuild');
    });

    test('settings.json is built from the layers, and VS Code uses it', async () => {
        await until(() => read('settings.json') !== null, 'settings.json');
        assert.ok(read('settings.json')!.startsWith(GENERATED_HEADER));
        assert.deepStrictEqual(json('settings.json'), {
            'editor.tabSize': 2,
            'files.exclude': { '**/dist': true },
            'editor.rulers': [100],
        });
        await until(() => vscode.workspace.getConfiguration('editor').inspect('tabSize')?.workspaceValue === 2, 'VS Code to read tabSize 2');
    });

    test('editing the shared file rebuilds settings.json', async () => {
        write('settings.shared.json', `// team\n{\n    "editor.tabSize": 4,\n    "files.exclude": { "**/dist": true },\n    "editor.insertSpaces": true,\n    "${block}": { "editor.rulers": [100] }\n}\n`);
        await until(() => json('settings.json')['editor.insertSpaces'] === true, 'insertSpaces in settings.json');
    });

    test('a change made in the Settings editor is saved to settings.local.json', async () => {
        await vscode.workspace.getConfiguration('editor').update('wordWrap', 'on', vscode.ConfigurationTarget.Workspace);
        await until(() => json('settings.local.json')['editor.wordWrap'] === 'on', 'wordWrap in settings.local.json');
        assert.ok(read('settings.local.json')!.includes('// mine'), 'comments in settings.local.json are kept');
        assert.ok(!('editor.wordWrap' in json('settings.shared.json')), 'the shared file is not touched');
        await until(() => json('settings.json')['editor.wordWrap'] === 'on', 'wordWrap kept in settings.json');
    });

    test('resetting a setting in the Settings editor removes it from settings.local.json', async () => {
        await vscode.workspace.getConfiguration('editor').update('wordWrap', undefined, vscode.ConfigurationTarget.Workspace);
        await until(() => !('editor.wordWrap' in json('settings.local.json')), 'wordWrap gone from settings.local.json');
    });

    test('resetting a shared setting brings the shared value back', async () => {
        await vscode.workspace.getConfiguration('editor').update('insertSpaces', undefined, vscode.ConfigurationTarget.Workspace);
        // VS Code removes it, then the rebuild puts the team value back
        await new Promise(r => setTimeout(r, 1000));
        await until(() => json('settings.json')['editor.insertSpaces'] === true, 'insertSpaces back in settings.json');
    });

    test('the hover says where a setting comes from', async () => {
        const doc = await vscode.workspace.openTextDocument(file('settings.json'));
        const at = doc.positionAt(doc.getText().indexOf('"editor.tabSize"') + 3);
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, at);
        const text = hovers.flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))).join('\n');
        assert.match(text, /settings\.shared\.json`? → `?settings\.local\.json/);

        const shared = await vscode.workspace.openTextDocument(file('settings.shared.json'));
        const sharedAt = shared.positionAt(shared.getText().indexOf('"editor.tabSize"') + 3);
        const sharedHovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', shared.uri, sharedAt);
        const sharedText = sharedHovers.flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))).join('\n');
        assert.match(sharedText, /overridden by `settings\.local\.json`/);
    });

    test('a broken layer shows a problem and the rest still builds', async () => {
        const before = read('settings.json');
        write('settings.local.json', '{ "editor.tabSize": }');
        await until(() => vscode.languages.getDiagnostics(vscode.Uri.file(file('settings.local.json'))).some(d => d.source === 'Settings Layers'), 'a diagnostic');
        assert.strictEqual(json('settings.json')['editor.tabSize'], 4, 'the broken file adds nothing, the shared value is used');
        assert.ok(before);
        write('settings.local.json', '// mine\n{\n    "editor.tabSize": 2\n}\n');
        await until(() => json('settings.json')['editor.tabSize'] === 2, 'tabSize 2 again');
        await until(() => vscode.languages.getDiagnostics(vscode.Uri.file(file('settings.local.json'))).length === 0, 'the problem cleared');
    });

    test('user settings for this system are applied and kept out of Settings Sync', async () => {
        const config = vscode.workspace.getConfiguration();
        const value = { [currentPlatform()]: { 'editor.fontSize': 19 }, other: undefined } as Record<string, unknown>;
        delete value.other;
        const otherPlatform = currentPlatform() === 'windows' ? 'macos' : 'windows';
        value[otherPlatform] = { 'editor.fontSize': 11, 'editor.lineHeight': 22 };
        await config.update('settingsLayers.platform', value, vscode.ConfigurationTarget.Global);

        await until(() => vscode.workspace.getConfiguration('editor').inspect('fontSize')?.globalValue === 19, 'fontSize 19 in user settings');
        assert.strictEqual(vscode.workspace.getConfiguration('editor').inspect('lineHeight')?.globalValue, undefined, 'other systems are not applied');
        await until(() => {
            const ignored = vscode.workspace.getConfiguration('settingsSync').inspect<string[]>('ignoredSettings')?.globalValue ?? [];
            return ignored.includes('editor.fontSize') && ignored.includes('editor.lineHeight');
        }, 'keys in settingsSync.ignoredSettings');

        await config.update('settingsLayers.platform', undefined, vscode.ConfigurationTarget.Global);
        await until(() => vscode.workspace.getConfiguration('editor').inspect('fontSize')?.globalValue === undefined, 'fontSize reset');
        await until(() => (vscode.workspace.getConfiguration('settingsSync').inspect<string[]>('ignoredSettings')?.globalValue ?? []).length === 0, 'ignored list cleaned');
    });
});

suite('Layer files get settings IntelliSense', () => {
    test('setting names are suggested at the top level and inside platform blocks, and the special keys are not flagged', async function () {
        this.timeout(30000);
        const text = `{\n    "editor.tabSize": 4,\n    "@extends": [],\n    "${block}": {\n        \n    }\n}\n`;
        write('settings.shared.json', text);
        const doc = await vscode.workspace.openTextDocument(file('settings.shared.json'));
        await vscode.window.showTextDocument(doc);
        assert.strictEqual(doc.languageId, 'jsonc');

        const inside = doc.positionAt(text.indexOf(`"${block}": {\n`) + `"${block}": {\n        `.length);
        let labels: string[] = [];
        const end = Date.now() + 20000;
        while (Date.now() < end && !labels.includes('editor.fontSize')) {
            const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, inside);
            labels = list.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label).replace(/"/g, ''));
            await new Promise(r => setTimeout(r, 300));
        }
        assert.ok(labels.includes('editor.fontSize'), `suggestions inside ${block}: ${labels.slice(0, 10).join(', ')}`);

        await new Promise(r => setTimeout(r, 1500));
        const problems = vscode.languages.getDiagnostics(doc.uri).map(d => d.message);
        assert.ok(!problems.some(m => /@extends|@windows|@macos|@linux|Unknown/i.test(m)), problems.join(' | '));
    });
});
