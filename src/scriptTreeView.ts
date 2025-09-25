import * as vscode from 'vscode';
import { ScriptScanner } from './scriptScanner';
import { Executor, ExecutionStatus } from './executor';

export class ScriptTreeProvider implements vscode.TreeDataProvider<ScriptItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ScriptItem | undefined | null | void> = new vscode.EventEmitter<ScriptItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ScriptItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(
        private scriptScanner: ScriptScanner,
        private executor: Executor
    ) {}

    refresh(): void {
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
                return Promise.resolve(
                    scripts.map(script => new ScriptItem(
                        script.name,
                        script.path,
                        undefined,
                        this.getScriptStatus(script.path),
                        vscode.TreeItemCollapsibleState.None
                    ))
                );
            }
            return Promise.resolve([]);
        } else {
            const allScripts = this.scriptScanner.getScripts();
            const items: ScriptItem[] = [];

            const sortedDirs = Array.from(allScripts.keys()).sort((a, b) => {
                if (a === 'root') return -1;
                if (b === 'root') return 1;
                return a.localeCompare(b);
            });

            for (const dir of sortedDirs) {
                const scripts = allScripts.get(dir) || [];
                if (scripts.length === 0) continue;

                if (dir === 'root') {
                    scripts.forEach(script => {
                        items.push(new ScriptItem(
                            script.name,
                            script.path,
                            undefined,
                            this.getScriptStatus(script.path),
                            vscode.TreeItemCollapsibleState.None
                        ));
                    });
                } else {
                    const displayName = dir.split('/').pop() || dir;
                    items.push(new ScriptItem(
                        displayName,
                        '',
                        dir,
                        'directory',
                        vscode.TreeItemCollapsibleState.Expanded
                    ));
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
