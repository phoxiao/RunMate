import * as vscode from 'vscode';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { ConfigManager } from './config';

export interface ScriptFile {
    name: string;
    path: string;
    directory: string;
    relativePath: string;
}

export class ScriptScanner implements vscode.Disposable {
    private scripts: Map<string, ScriptFile[]> = new Map();
    private watcher: chokidar.FSWatcher | undefined;
    private configManager: ConfigManager;

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
        this.scanScripts();
    }

    public async scanScripts(): Promise<void> {
        this.scripts.clear();

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }

        const ignorePatterns = this.configManager.getIgnoreDirectories();

        for (const folder of workspaceFolders) {
            const pattern = new vscode.RelativePattern(folder, '**/*.sh');
            const files = await vscode.workspace.findFiles(pattern, this.createExcludePattern(ignorePatterns));

            for (const file of files) {
                const filePath = file.fsPath;
                const fileName = path.basename(filePath);
                const directory = path.dirname(filePath);
                const relativePath = vscode.workspace.asRelativePath(filePath);
                const relativeDir = path.dirname(relativePath);

                const scriptFile: ScriptFile = {
                    name: fileName,
                    path: filePath,
                    directory: directory,
                    relativePath: relativePath
                };

                const dirKey = relativeDir === '.' ? 'root' : relativeDir;

                if (!this.scripts.has(dirKey)) {
                    this.scripts.set(dirKey, []);
                }

                this.scripts.get(dirKey)!.push(scriptFile);
            }
        }

        this.sortScripts();
    }

    private createExcludePattern(ignoreDirectories: string[]): string {
        const patterns = ignoreDirectories.map(dir => `**/${dir}/**`);
        return `{${patterns.join(',')}}`;
    }

    private sortScripts(): void {
        const customSort = this.configManager.getCustomSort();

        for (const scripts of this.scripts.values()) {
            scripts.sort((a, b) => {
                const aIndex = customSort.indexOf(a.name);
                const bIndex = customSort.indexOf(b.name);

                if (aIndex !== -1 && bIndex !== -1) {
                    return aIndex - bIndex;
                }
                if (aIndex !== -1) {
                    return -1;
                }
                if (bIndex !== -1) {
                    return 1;
                }

                return a.name.localeCompare(b.name);
            });
        }
    }

    public getScripts(): Map<string, ScriptFile[]> {
        return this.scripts;
    }

    public getAllScripts(): ScriptFile[] {
        const allScripts: ScriptFile[] = [];
        for (const scripts of this.scripts.values()) {
            allScripts.push(...scripts);
        }
        return allScripts;
    }

    public getScriptsByDirectory(directory: string): ScriptFile[] {
        return this.scripts.get(directory) || [];
    }

    public startWatching(onChange: () => void): void {
        if (this.watcher) {
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }

        const paths = workspaceFolders.map(folder => folder.uri.fsPath);
        const ignorePatterns = this.configManager.getIgnoreDirectories();

        let debounceTimer: NodeJS.Timeout | undefined;
        const debouncedOnChange = () => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = setTimeout(async () => {
                await this.scanScripts();
                onChange();
            }, 500);
        };

        this.watcher = chokidar.watch('**/*.sh', {
            cwd: paths[0],
            ignored: ignorePatterns.map(dir => `**/${dir}/**`),
            persistent: true,
            ignoreInitial: true,
            followSymlinks: false,
            awaitWriteFinish: {
                stabilityThreshold: 300,
                pollInterval: 100
            }
        });

        this.watcher
            .on('add', debouncedOnChange)
            .on('unlink', debouncedOnChange)
            .on('change', debouncedOnChange);
    }

    public stopWatching(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = undefined;
        }
    }

    public dispose(): void {
        this.stopWatching();
    }

    public findScript(filePath: string): ScriptFile | undefined {
        for (const scripts of this.scripts.values()) {
            const script = scripts.find(s => s.path === filePath);
            if (script) {
                return script;
            }
        }
        return undefined;
    }

    public async searchScripts(query: string): Promise<ScriptFile[]> {
        const results: ScriptFile[] = [];
        const lowerQuery = query.toLowerCase();

        for (const scripts of this.scripts.values()) {
            for (const script of scripts) {
                if (script.name.toLowerCase().includes(lowerQuery) ||
                    script.relativePath.toLowerCase().includes(lowerQuery)) {
                    results.push(script);
                }
            }
        }

        return results;
    }
}
