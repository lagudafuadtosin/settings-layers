import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    allPlatformKeys,
    applyToLocal,
    buildSettings,
    currentPlatform,
    findChanges,
    GENERATED_HEADER,
    LayerFile,
    parseSettings,
    platformBlock,
    Platform,
    render,
} from '../../core/layers';
import { folderIgnored, missingIgnoreLines, withIgnoreLines } from '../../core/gitignore';
import { resolveExtends } from '../../core/resolve';

const SHARED = path.resolve('/w/.vscode/settings.shared.json');
const LOCAL = path.resolve('/w/.vscode/settings.local.json');

function build(shared: string | null, local: string | null, platform: Platform = 'windows', files: Record<string, string> = {}) {
    const read = (p: string) => files[path.resolve(p)] ?? null;
    const paths = { resolve: (from: string, rel: string) => path.resolve(path.dirname(from), rel) };
    const sharedFile: LayerFile = { path: SHARED, text: shared };
    const localFile: LayerFile = { path: LOCAL, text: local };
    return buildSettings(sharedFile, localFile, platform, read, paths);
}

suite('merge', () => {
    test('local wins over shared', () => {
        const r = build('{ "editor.tabSize": 4, "editor.rulers": [80] }', '{ "editor.tabSize": 2 }');
        assert.deepStrictEqual(r.settings, { 'editor.tabSize': 2, 'editor.rulers': [80] });
        assert.deepStrictEqual(r.errors, []);
    });

    test('objects merge key by key, arrays are replaced', () => {
        const r = build(
            '{ "files.exclude": { "**/dist": true, "**/out": true }, "[python]": { "editor.tabSize": 4 }, "editor.rulers": [80, 120] }',
            '{ "files.exclude": { "**/out": false, "**/tmp": true }, "[python]": { "editor.formatOnSave": true }, "editor.rulers": [100] }'
        );
        assert.deepStrictEqual(r.settings, {
            'files.exclude': { '**/dist': true, '**/out': false, '**/tmp': true },
            '[python]': { 'editor.tabSize': 4, 'editor.formatOnSave': true },
            'editor.rulers': [100],
        });
    });

    test('comments and trailing commas are allowed', () => {
        const r = build('// team\n{\n  /* size */ "editor.tabSize": 4,\n}\n', null);
        assert.deepStrictEqual(r.settings, { 'editor.tabSize': 4 });
        assert.deepStrictEqual(r.errors, []);
    });

    test('a missing layer is skipped', () => {
        assert.deepStrictEqual(build(null, '{ "a": 1 }').settings, { a: 1 });
        assert.deepStrictEqual(build('{ "a": 1 }', null).settings, { a: 1 });
    });

    test('broken JSON is reported and the rest still builds', () => {
        const r = build('{ "a": 1, "b": }', '{ "c": 3 }');
        assert.strictEqual(r.settings.c, 3);
        assert.ok(r.errors.length > 0);
        assert.strictEqual(r.errors[0].file, SHARED);
        assert.match(r.errors[0].message, /at offset \d+/);
    });

    test('a layer that is not an object is reported', () => {
        const r = build('[1, 2]', null);
        assert.deepStrictEqual(r.settings, {});
        assert.ok(r.errors.some(e => /not a JSON object/.test(e.message)));
    });

    test('layers do not share objects with each other', () => {
        const r = build('{ "o": { "a": 1 } }', '{ "o": { "b": 2 } }');
        (r.settings.o as Record<string, number>).c = 3;
        const again = build('{ "o": { "a": 1 } }', '{ "o": { "b": 2 } }');
        assert.deepStrictEqual(again.settings.o, { a: 1, b: 2 });
    });
});

suite('platform blocks', () => {
    const shared = '{ "terminal.integrated.fontSize": 12, "@windows": { "terminal.integrated.fontSize": 13, "git.path": "C:\\\\Git\\\\bin\\\\git.exe" }, "@macos": { "terminal.integrated.fontSize": 15 } }';

    test('only this system\'s block applies', () => {
        assert.deepStrictEqual(build(shared, null, 'windows').settings, { 'terminal.integrated.fontSize': 13, 'git.path': 'C:\\Git\\bin\\git.exe' });
        assert.deepStrictEqual(build(shared, null, 'macos').settings, { 'terminal.integrated.fontSize': 15 });
        assert.deepStrictEqual(build(shared, null, 'linux').settings, { 'terminal.integrated.fontSize': 12 });
    });

    test('local settings win over the shared platform block', () => {
        const r = build(shared, '{ "terminal.integrated.fontSize": 20 }', 'windows');
        assert.strictEqual(r.settings['terminal.integrated.fontSize'], 20);
    });

    test('a layer\'s platform block wins over its own plain settings, whatever the order in the file', () => {
        const r = build('{ "@linux": { "a": 2 }, "a": 1 }', null, 'linux');
        assert.strictEqual(r.settings.a, 2);
    });

    test('a block that is not an object is reported', () => {
        const r = build('{ "@windows": 5 }', null, 'windows');
        assert.ok(r.errors.some(e => /@windows must be an object/.test(e.message)));
    });

    test('platform blocks never reach settings.json', () => {
        const r = build(shared, '{ "@linux": { "x": 1 } }', 'windows');
        assert.ok(!('@windows' in r.settings) && !('@macos' in r.settings) && !('@linux' in r.settings));
    });

    test('node platform names map to ours', () => {
        assert.strictEqual(currentPlatform('win32'), 'windows');
        assert.strictEqual(currentPlatform('darwin'), 'macos');
        assert.strictEqual(currentPlatform('linux'), 'linux');
        assert.strictEqual(currentPlatform('freebsd'), 'linux');
    });
});

suite('@extends', () => {
    const base = path.resolve('/w/config/base.json');
    const strict = path.resolve('/w/config/strict.json');

    test('extended files apply first, then the file itself', () => {
        const r = build('{ "@extends": "../config/base.json", "a": 2 }', null, 'windows', {
            [base]: '{ "a": 1, "b": 1 }',
        });
        assert.deepStrictEqual(r.settings, { a: 2, b: 1 });
        assert.deepStrictEqual(r.files, [SHARED, base]);
    });

    test('a list applies in order, and extends can nest', () => {
        const r = build('{ "@extends": ["../config/base.json", "../config/strict.json"] }', null, 'windows', {
            [base]: '{ "a": 1, "b": 1 }',
            [strict]: '{ "@extends": "./base.json", "b": 2, "@windows": { "c": 3 } }',
        });
        assert.deepStrictEqual(r.settings, { a: 1, b: 2, c: 3 });
        assert.deepStrictEqual(r.origins.get('b'), [base, strict]);
    });

    test('local can extend too, and still wins', () => {
        const r = build('{ "a": 1 }', '{ "@extends": "../config/base.json", "b": 5 }', 'windows', {
            [base]: '{ "a": 9, "b": 9 }',
        });
        assert.deepStrictEqual(r.settings, { a: 9, b: 5 });
    });

    test('a missing file is reported and watched', () => {
        const r = build('{ "@extends": "./nope.json", "a": 1 }', null);
        assert.deepStrictEqual(r.settings, { a: 1 });
        assert.ok(r.errors.some(e => /not found: \.\/nope\.json/.test(e.message)));
        assert.ok(r.files.includes(path.resolve('/w/.vscode/nope.json')));
    });

    test('a loop is reported, not followed forever', () => {
        const r = build('{ "@extends": "../config/base.json" }', null, 'windows', {
            [base]: '{ "@extends": "./strict.json", "a": 1 }',
            [strict]: '{ "@extends": "./base.json", "b": 1 }',
        });
        assert.ok(r.errors.some(e => /loops back/.test(e.message)));
        assert.deepStrictEqual(r.settings, { a: 1, b: 1 });
    });

    test('entries that are not strings are reported', () => {
        const r = build('{ "@extends": [5] }', null);
        assert.ok(r.errors.some(e => /must be file paths/.test(e.message)));
    });
});

suite('origins', () => {
    test('every file that set a key is listed, last one wins', () => {
        const r = build('{ "a": 1, "@windows": { "a": 2 } }', '{ "a": 3, "b": 1 }');
        assert.deepStrictEqual(r.origins.get('a'), [SHARED, LOCAL]);
        assert.deepStrictEqual(r.origins.get('b'), [LOCAL]);
        assert.ok(!r.origins.has('@windows'));
    });
});

suite('render', () => {
    test('starts with the header and parses back to the same settings', () => {
        const settings = { 'editor.tabSize': 2, 'files.exclude': { '**/out': true } };
        const text = render(settings);
        assert.ok(text.startsWith(GENERATED_HEADER));
        assert.deepStrictEqual(parseSettings(text, 'x', []), settings);
    });
});

suite('capturing edits made to settings.json', () => {
    test('changed, added and removed settings are found', () => {
        const generated = { a: 1, b: [1], c: { x: 1 }, d: true };
        const current = { a: 2, b: [1], c: { x: 1, y: 2 }, e: 'new' };
        assert.deepStrictEqual(findChanges(generated, current), { set: { a: 2, c: { x: 1, y: 2 }, e: 'new' }, removed: ['d'] });
    });

    test('nothing changed, nothing found', () => {
        assert.deepStrictEqual(findChanges({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }), { set: {}, removed: [] });
    });

    test('changes are written into settings.local.json, keeping its comments', () => {
        const local = '// mine\n{\n    // big font\n    "editor.fontSize": 16,\n    "old": 1\n}\n';
        const out = applyToLocal(local, { set: { 'editor.fontSize': 18, 'editor.wordWrap': 'on' }, removed: ['old'] });
        assert.ok(out.includes('// mine') && out.includes('// big font'), out);
        assert.deepStrictEqual(parseSettings(out, 'x', []), { 'editor.fontSize': 18, 'editor.wordWrap': 'on' });
    });

    test('a missing or empty settings.local.json is created', () => {
        for (const start of [null, '', '  \n']) {
            const out = applyToLocal(start, { set: { a: 1 }, removed: [] });
            assert.deepStrictEqual(parseSettings(out, 'x', []), { a: 1 });
        }
    });

    test('the round trip: edit settings.json, capture, rebuild gives the edited settings', () => {
        const shared = '{ "editor.tabSize": 4, "files.exclude": { "**/dist": true } }';
        let local: string | null = null;
        const first = build(shared, local).settings;
        const edited = { ...first, 'editor.tabSize': 2, 'editor.minimap.enabled': false };
        local = applyToLocal(local, findChanges(first, edited));
        assert.deepStrictEqual(build(shared, local).settings, edited);
    });
});

suite('user platform blocks', () => {
    const value = { windows: { a: 1, b: 2 }, macos: { a: 3, c: 4 }, linux: 'bad' };

    test('the block for this system', () => {
        assert.deepStrictEqual(platformBlock(value, 'windows'), { a: 1, b: 2 });
        assert.deepStrictEqual(platformBlock(value, 'linux'), {});
        assert.deepStrictEqual(platformBlock(undefined, 'macos'), {});
    });

    test('every key in any block, for Settings Sync', () => {
        assert.deepStrictEqual(allPlatformKeys(value).sort(), ['a', 'b', 'c']);
        assert.deepStrictEqual(allPlatformKeys(null), []);
    });
});

suite('.gitignore', () => {
    test('adds both lines to an empty or missing file', () => {
        assert.deepStrictEqual(missingIgnoreLines(null), ['.vscode/settings.json', '.vscode/settings.local.json']);
        assert.strictEqual(withIgnoreLines(null, ['x']), '# VS Code: generated and personal settings (Settings Layers)\nx\n');
    });

    test('only adds what is missing', () => {
        assert.deepStrictEqual(missingIgnoreLines('node_modules\n/.vscode/settings.json\n'), ['.vscode/settings.local.json']);
        assert.deepStrictEqual(missingIgnoreLines('.vscode/settings.json\r\n.vscode/settings.local.json\r\n'), []);
    });

    test('".vscode/*" needs the shared file let back in', () => {
        assert.deepStrictEqual(missingIgnoreLines('.vscode/*\n'), ['!.vscode/settings.shared.json']);
        assert.deepStrictEqual(missingIgnoreLines('.vscode/*\n!.vscode/settings.shared.json\n'), []);
    });

    test('a fully ignored .vscode folder is spotted', () => {
        assert.ok(folderIgnored('/.vscode\n'));
        assert.ok(folderIgnored('.vscode/'));
        assert.ok(!folderIgnored('.vscode/*'));
        assert.deepStrictEqual(missingIgnoreLines('.vscode/\n'), []);
    });

    test('appends after existing text with a blank line', () => {
        assert.strictEqual(withIgnoreLines('node_modules', ['a']), 'node_modules\n\n# VS Code: generated and personal settings (Settings Layers)\na\n');
    });
});

suite('resolving @extends', () => {
    test('relative paths are relative to the file', () => {
        assert.strictEqual(resolveExtends(SHARED, './team.json'), path.resolve('/w/.vscode/team.json'));
        assert.strictEqual(resolveExtends(SHARED, '../base.json'), path.resolve('/w/base.json'));
    });

    test('package paths are found in the nearest node_modules', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layers-'));
        try {
            const file = path.join(root, 'node_modules', '@acme', 'settings', 'base.json');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '{}');
            const from = path.join(root, 'packages', 'app', '.vscode', 'settings.shared.json');
            assert.strictEqual(resolveExtends(from, '@acme/settings/base.json'), file);
            // Not installed: points into the nearest node_modules so the error is clear
            assert.strictEqual(resolveExtends(from, 'missing/x.json'), path.join(path.dirname(from), 'node_modules', 'missing', 'x.json'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
