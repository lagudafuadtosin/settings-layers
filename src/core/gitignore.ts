/**
 * The .gitignore lines a layered folder needs: the generated settings.json and the personal
 * settings.local.json stay out of git, settings.shared.json goes in.
 */
export const IGNORE_LINES = ['.vscode/settings.json', '.vscode/settings.local.json'];

/** Lines from IGNORE_LINES that the .gitignore text does not already cover. */
export function missingIgnoreLines(gitignore: string | null): string[] {
    const present = new Set(
        (gitignore ?? '')
            .split(/\r?\n/)
            .map(l => l.trim().replace(/^\//, ''))
            .filter(l => l && !l.startsWith('#'))
    );
    if (present.has('.vscode/*')) {
        // Everything in the folder is ignored already: let the shared file back in
        return present.has('!.vscode/settings.shared.json') ? [] : ['!.vscode/settings.shared.json'];
    }
    if (folderIgnored(gitignore)) { return []; }
    return IGNORE_LINES.filter(l => !present.has(l));
}

/**
 * True when the whole .vscode folder is ignored ("/.vscode" or ".vscode/"). Git cannot let a
 * file back in from an ignored folder, so settings.shared.json would never be committed.
 */
export function folderIgnored(gitignore: string | null): boolean {
    return (gitignore ?? '')
        .split(/\r?\n/)
        .map(l => l.trim().replace(/^\//, ''))
        .some(l => l === '.vscode' || l === '.vscode/');
}

/** The .gitignore text with the missing lines appended under a short heading. */
export function withIgnoreLines(gitignore: string | null, lines: string[]): string {
    if (lines.length === 0) { return gitignore ?? ''; }
    const base = gitignore ?? '';
    const sep = base === '' || base.endsWith('\n') ? '' : '\n';
    const gap = base === '' ? '' : '\n';
    return `${base}${sep}${gap}# VS Code: generated and personal settings (Settings Layers)\n${lines.join('\n')}\n`;
}
