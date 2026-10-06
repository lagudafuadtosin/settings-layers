import { parse, ParseError, printParseErrorCode, modify, applyEdits } from 'jsonc-parser';

/**
 * Settings Layers: builds a workspace's settings.json from layers.
 *
 *   @extends files  →  settings.shared.json  →  settings.local.json
 *
 * Every layer may hold "@windows", "@macos" and "@linux" blocks that apply on that platform
 * only, right after the layer's own settings. Later layers win. Objects (like "files.exclude"
 * or "[python]") merge key by key, everything else is replaced.
 *
 * Pure functions only (no VS Code), so all of this is unit-tested.
 */

export type Settings = Record<string, unknown>;
export type Platform = 'windows' | 'macos' | 'linux';

export const EXTENDS_KEY = '@extends';
export const PLATFORM_KEYS: Record<Platform, string> = { windows: '@windows', macos: '@macos', linux: '@linux' };
const RESERVED = new Set([EXTENDS_KEY, ...Object.values(PLATFORM_KEYS)]);
const MAX_EXTENDS_DEPTH = 10;

export function currentPlatform(nodePlatform: string = process.platform): Platform {
    if (nodePlatform === 'win32') { return 'windows'; }
    if (nodePlatform === 'darwin') { return 'macos'; }
    return 'linux';
}

export interface LayerError {
    file: string;
    message: string;
}

/** Parses JSON with comments and trailing commas. Errors are reported, not thrown. */
export function parseSettings(text: string, file: string, errors: LayerError[]): Settings {
    const parseErrors: ParseError[] = [];
    const value = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false });
    for (const e of parseErrors) {
        errors.push({ file, message: `${printParseErrorCode(e.error)} at offset ${e.offset}` });
    }
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
        if (text.trim() !== '') { errors.push({ file, message: 'is not a JSON object' }); }
        return {};
    }
    return value as Settings;
}

function isPlainObject(v: unknown): v is Settings {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/** Merges `source` into `target`: objects merge key by key, other values replace. */
export function mergeInto(target: Settings, source: Settings): void {
    for (const [key, value] of Object.entries(source)) {
        if (RESERVED.has(key)) { continue; }
        const existing = target[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            const merged = clone(existing);
            mergeInto(merged, value);
            target[key] = merged;
        } else {
            target[key] = clone(value);
        }
    }
}

export interface LayerFile {
    /** Absolute path of the file. */
    path: string;
    /** File contents, or null when the file does not exist. */
    text: string | null;
}

export interface ReadFile {
    (path: string): string | null;
}

export interface PathTools {
    resolve(fromFile: string, relative: string): string;
}

export interface BuildResult {
    settings: Settings;
    /** For each setting, the files that set it, in the order they were applied. */
    origins: Map<string, string[]>;
    /** Every file read, including @extends targets, so callers can watch them. */
    files: string[];
    errors: LayerError[];
}

/**
 * Applies one layer file: its @extends files first (recursively), then its own settings, then
 * its block for this platform.
 */
function applyLayer(
    file: LayerFile,
    platform: Platform,
    read: ReadFile,
    paths: PathTools,
    result: BuildResult,
    chain: string[]
): void {
    if (file.text === null) { return; }
    if (chain.includes(file.path)) {
        result.errors.push({ file: file.path, message: `@extends loops back to itself (${[...chain, file.path].join(' → ')})` });
        return;
    }
    if (chain.length > MAX_EXTENDS_DEPTH) {
        result.errors.push({ file: file.path, message: `@extends is nested more than ${MAX_EXTENDS_DEPTH} levels deep` });
        return;
    }
    if (!result.files.includes(file.path)) { result.files.push(file.path); }

    const settings = parseSettings(file.text, file.path, result.errors);

    const extendsValue = settings[EXTENDS_KEY];
    const extendsList = typeof extendsValue === 'string' ? [extendsValue] : Array.isArray(extendsValue) ? extendsValue : [];
    for (const entry of extendsList) {
        if (typeof entry !== 'string') {
            result.errors.push({ file: file.path, message: '@extends entries must be file paths' });
            continue;
        }
        const target = paths.resolve(file.path, entry);
        const text = read(target);
        if (text === null) {
            result.errors.push({ file: file.path, message: `@extends file not found: ${entry}` });
            if (!result.files.includes(target)) { result.files.push(target); }
            continue;
        }
        applyLayer({ path: target, text }, platform, read, paths, result, [...chain, file.path]);
    }

    record(result, settings, file.path);
    const block = settings[PLATFORM_KEYS[platform]];
    if (block !== undefined) {
        if (isPlainObject(block)) {
            record(result, block, file.path);
        } else {
            result.errors.push({ file: file.path, message: `${PLATFORM_KEYS[platform]} must be an object` });
        }
    }
}

function record(result: BuildResult, settings: Settings, file: string): void {
    mergeInto(result.settings, settings);
    for (const key of Object.keys(settings)) {
        if (RESERVED.has(key)) { continue; }
        const list = result.origins.get(key) ?? [];
        if (list[list.length - 1] !== file) { list.push(file); }
        result.origins.set(key, list);
    }
}

/** Builds the settings for one workspace folder from its shared and local layers. */
export function buildSettings(
    shared: LayerFile,
    local: LayerFile,
    platform: Platform,
    read: ReadFile,
    paths: PathTools
): BuildResult {
    const result: BuildResult = { settings: {}, origins: new Map(), files: [], errors: [] };
    applyLayer(shared, platform, read, paths, result, []);
    applyLayer(local, platform, read, paths, result, []);
    return result;
}

export const GENERATED_HEADER =
    '// Generated by Settings Layers from settings.shared.json and settings.local.json.\n' +
    '// Edit those files. Changes made here (or in the Settings editor) are saved to settings.local.json.\n';

export function render(settings: Settings): string {
    return GENERATED_HEADER + JSON.stringify(settings, null, 4) + '\n';
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) { return true; }
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') { return false; }
    if (Array.isArray(a) !== Array.isArray(b)) { return false; }
    if (Array.isArray(a)) {
        const bArr = b as unknown[];
        return a.length === bArr.length && a.every((v, i) => deepEqual(v, bArr[i]));
    }
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    return ak.length === bk.length && ak.every(k => deepEqual((a as Settings)[k], (b as Settings)[k]));
}

export interface CapturedChange {
    /** Settings added or changed in settings.json since we generated it. */
    set: Settings;
    /** Settings removed from settings.json since we generated it. */
    removed: string[];
}

/** What someone changed in settings.json (by hand or in the Settings editor) since we wrote it. */
export function findChanges(generated: Settings, current: Settings): CapturedChange {
    const set: Settings = {};
    const removed: string[] = [];
    for (const [key, value] of Object.entries(current)) {
        if (!deepEqual(generated[key], value)) { set[key] = value; }
    }
    for (const key of Object.keys(generated)) {
        if (!(key in current)) { removed.push(key); }
    }
    return { set, removed };
}

/**
 * Writes captured changes into settings.local.json text, keeping its comments and layout.
 * A removed setting is removed from the local layer; if it came from a shared layer it
 * stays (the shared value wins again), which the caller reports.
 */
export function applyToLocal(localText: string | null, change: CapturedChange): string {
    let text = localText && localText.trim() !== '' ? localText : '{\n}\n';
    const options = { formattingOptions: { insertSpaces: true, tabSize: 4, eol: '\n' } };
    for (const [key, value] of Object.entries(change.set)) {
        text = applyEdits(text, modify(text, [key], value, options));
    }
    for (const key of change.removed) {
        text = applyEdits(text, modify(text, [key], undefined, options));
    }
    return text;
}

/** Keys from a user-level platform block, for the current platform. */
export function platformBlock(value: unknown, platform: Platform): Settings {
    if (!isPlainObject(value)) { return {}; }
    const block = value[platform];
    return isPlainObject(block) ? block : {};
}

/** Every key named in any platform's block, so all of them can be kept out of Settings Sync. */
export function allPlatformKeys(value: unknown): string[] {
    if (!isPlainObject(value)) { return []; }
    const keys = new Set<string>();
    for (const p of ['windows', 'macos', 'linux'] as Platform[]) {
        const block = value[p];
        if (isPlainObject(block)) { Object.keys(block).forEach(k => keys.add(k)); }
    }
    return [...keys];
}
