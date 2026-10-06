import * as fs from 'fs';
import * as path from 'path';

/**
 * Where an "@extends" entry points.
 *
 *   "./team.json", "../base.json", "/abs/file.json"   relative to the file that names it
 *   "@acme/vscode-settings/base.json"                 a file inside an npm package, found in the
 *                                                       nearest node_modules folder (like tsconfig)
 */
export function resolveExtends(fromFile: string, entry: string, exists: (p: string) => boolean = fs.existsSync): string {
    const dir = path.dirname(fromFile);
    if (entry.startsWith('./') || entry.startsWith('../') || entry.startsWith('.\\') || entry.startsWith('..\\') || path.isAbsolute(entry)) {
        return path.resolve(dir, entry);
    }
    let current = dir;
    for (;;) {
        const candidate = path.join(current, 'node_modules', entry);
        if (exists(candidate)) { return candidate; }
        const parent = path.dirname(current);
        if (parent === current) { break; }
        current = parent;
    }
    // Not installed: report it where it would be in the nearest node_modules
    return path.join(dir, 'node_modules', entry);
}

export function readText(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}
