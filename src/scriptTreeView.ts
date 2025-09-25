import * as vscode from 'vscode';
import { ScriptScanner } from './scriptScanner';
import { Executor, ExecutionStatus } from './executor';

export class ScriptTreeProvider implements vscode.TreeDataProvider<ScriptItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ScriptItem | undefined | null | void> = new vscode.EventEmitter<ScriptItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ScriptItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private itemCache: Map<string, ScriptItem> = new Map();

    constructor(
        private scriptScanner: ScriptScanner,
        private executor: Executor
    ) {
        // Trigger initial load
        setTimeout(() => {
            this._onDidChangeTreeData.fire();
        }, 100);
    }

    refresh(): void {
        // Clear cache to ensure fresh status updates
        this.itemCache.clear();
        this.scriptScanner.scanScripts().then(() => {
            this._onDidChangeTreeData.fire();
        });
    }

    getTreeItem(element: ScriptItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ScriptItem): Thenable<ScriptItem[]> {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showInformationMessage('No scripts found in empty workspace');
            return Promise.resolve([]);
        }

        if (element) {
            if (element.contextValue === 'directory') {
                const scripts = this.scriptScanner.getScriptsByDirectory(element.directory || '');
                const items: ScriptItem[] = [];
                const seen = new Set<string>();

                for (const script of scripts) {
                    if (!seen.has(script.path)) {
                        seen.add(script.path);
                        // Don't cache items with dynamic status
                        const item = new ScriptItem(
                            script.name,
                            script.path,
                            undefined,
                            this.getScriptStatus(script.path),
                            vscode.TreeItemCollapsibleState.None
                        );
                        items.push(item);
                    }
                }
                return Promise.resolve(items);
            }
            return Promise.resolve([]);
        } else {
            this.itemCache.clear();
            const allScripts = this.scriptScanner.getScripts();

            // If no scripts found, try scanning again
            if (allScripts.size === 0) {
                this.scriptScanner.scanScripts().then(() => {
                    // Trigger refresh after scan completes
                    setTimeout(() => this._onDidChangeTreeData.fire(), 50);
                });
                return Promise.resolve([]);
            }

            const items: ScriptItem[] = [];
            const seenScripts = new Set<string>();
            const seenDirs = new Set<string>();

            const sortedDirs = Array.from(allScripts.keys()).sort((a, b) => {
                if (a === 'root') return -1;
                if (b === 'root') return 1;
                return a.localeCompare(b);
            });

            for (const dir of sortedDirs) {
                const scripts = allScripts.get(dir) || [];
                if (scripts.length === 0) continue;

                if (dir === 'root') {
                    for (const script of scripts) {
                        if (!seenScripts.has(script.path)) {
                            seenScripts.add(script.path);
                            // Always create fresh items to get current status
                            const item = new ScriptItem(
                                script.name,
                                script.path,
                                undefined,
                                this.getScriptStatus(script.path),
                                vscode.TreeItemCollapsibleState.None
                            );
                            items.push(item);
                        }
                    }
                } else {
                    if (!seenDirs.has(dir)) {
                        seenDirs.add(dir);
                        const displayName = dir.split('/').pop() || dir;
                        const cacheKey = `dir_${dir}`;
                        const item = new ScriptItem(
                            displayName,
                            '',
                            dir,
                            'directory',
                            vscode.TreeItemCollapsibleState.Expanded
                        );
                        this.itemCache.set(cacheKey, item);
                        items.push(item);
                    }
                }
            }

            return Promise.resolve(items);
        }
    }

    private getScriptStatus(filePath: string): string {
        const status = this.executor.getScriptStatus(filePath);
        switch (status) {
            case ExecutionStatus.Running:
                return 'running';
            case ExecutionStatus.Success:
                return 'success';
            case ExecutionStatus.Failed:
                return 'failed';
            default:
                return 'script';
        }
    }
}

export class ScriptItem extends vscode.TreeItem {
    constructor(
        public override readonly label: string,
        public readonly filePath: string,
        public readonly directory: string | undefined,
        public override readonly contextValue: string,
        public override readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public override readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);

        this.tooltip = this.filePath || this.directory || this.label;

        if (contextValue === 'directory') {
            this.iconPath = new vscode.ThemeIcon('folder');
        } else {
            switch (contextValue) {
                case 'running':
                    this.iconPath = new vscode.ThemeIcon('sync~spin');
                    this.description = 'Running';
                    break;
                case 'success':
                    this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
                    this.description = 'Success';
                    break;
                case 'failed':
                    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
                    this.description = 'Failed';
                    break;
                default:
                    this.iconPath = new vscode.ThemeIcon('file-code');
                    break;
            }
        }

        if (contextValue === 'script' || contextValue === 'running') {
            this.command = {
                command: 'runmate.openScript',
                title: 'Open Script',
                arguments: [this]
            };
        }
    }
}
