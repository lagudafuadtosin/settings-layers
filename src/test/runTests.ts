import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        // An empty workspace folder for the layer files
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-layers-test-'));

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
