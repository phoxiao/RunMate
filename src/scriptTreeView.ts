import * as vscode from 'vscode';
import { ScriptScanner } from './scriptScanner';
import { Executor, ExecutionStatus } from './executor';

export class ScriptTreeProvider implements vscode.TreeDataProvider<ScriptItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ScriptItem | undefined | null | void> = new vscode.EventEmitter<ScriptItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ScriptItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private itemCache: Map<string, ScriptItem> = new Map();
    private searchQuery: string = '';
    private treeView: vscode.TreeView<ScriptItem> | undefined;
    private searchStatusBarItem: vscode.StatusBarItem;

    constructor(
        private scriptScanner: ScriptScanner,
        private executor: Executor,
        context: vscode.ExtensionContext
    ) {
        // Create status bar item for search indicator
        this.searchStatusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            50
        );
        this.searchStatusBarItem.command = 'runmate.searchScripts';
        context.subscriptions.push(this.searchStatusBarItem);

        // Trigger initial load
        setTimeout(() => {
            this._onDidChangeTreeData.fire();
        }, 100);
    }

    setTreeView(treeView: vscode.TreeView<ScriptItem>): void {
        this.treeView = treeView;
    }

    setSearchQuery(query: string): void {
        this.searchQuery = query.toLowerCase();
        this.updateTreeViewTitle();
        this.refresh();
    }

    clearSearch(): void {
        this.searchQuery = '';
        this.updateTreeViewTitle();
        this.refresh();
    }

    getSearchQuery(): string {
        return this.searchQuery;
    }

    private updateTreeViewTitle(): void {
        if (this.treeView) {
            if (this.searchQuery) {
                this.treeView.description = `🔍 "${this.searchQuery}"`;
            } else {
                this.treeView.description = undefined;
            }
        }

        // Update status bar
        if (this.searchQuery) {
            this.searchStatusBarItem.text = `$(search) Filter: "${this.searchQuery}"`;
            this.searchStatusBarItem.tooltip = 'Click to modify search or press Escape to clear';
            this.searchStatusBarItem.show();
        } else {
            this.searchStatusBarItem.hide();
        }
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
            // Don't show children for search box
            if (element.contextValue === 'searchBox') {
                return Promise.resolve([]);
            }

            if (element.contextValue === 'directory') {
                const scripts = this.scriptScanner.getScriptsByDirectory(element.directory || '');
                const items: ScriptItem[] = [];
                const seen = new Set<string>();

                for (const script of scripts) {
                    // Apply search filter for scripts in directories
                    if (this.searchQuery && !this.matchesSearch(script.name)) {
                        continue;
                    }

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
                // Still show search box even if no scripts
                const searchBoxLabel = this.searchQuery
                    ? `Search: ${this.searchQuery}`
                    : 'Click to search scripts...';
                const searchBox = new ScriptItem(
                    searchBoxLabel,
                    '',
                    undefined,
                    'searchBox',
                    vscode.TreeItemCollapsibleState.None
                );

                // Add clear button description when there's a search
                if (this.searchQuery) {
                    searchBox.description = '$(close) Clear';
                }

                return Promise.resolve([searchBox]);
            }

            const items: ScriptItem[] = [];

            // Add search status as first item
            if (this.searchQuery) {
                const searchStatus = new ScriptItem(
                    `Searching: "${this.searchQuery}"`,
                    '',
                    undefined,
                    'searchStatus',
                    vscode.TreeItemCollapsibleState.None
                );
                searchStatus.description = '$(close) Clear (Esc)';
                items.push(searchStatus);
            }

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

                // Filter scripts if there's a search query
                const filteredScripts = this.searchQuery
                    ? scripts.filter(script => this.matchesSearch(script.name))
                    : scripts;

                if (filteredScripts.length === 0 && this.searchQuery) continue;

                if (dir === 'root') {
                    for (const script of filteredScripts) {
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
                    // Only show directories if they contain filtered scripts
                    if (filteredScripts.length > 0) {
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
            }

            return Promise.resolve(items);
        }
    }

    private matchesSearch(filename: string): boolean {
        if (!this.searchQuery) return true;
        // Fuzzy matching: check if all characters in search query appear in order
        const lowerFilename = filename.toLowerCase();
        let searchIndex = 0;

        for (let i = 0; i < lowerFilename.length && searchIndex < this.searchQuery.length; i++) {
            if (lowerFilename[i] === this.searchQuery[searchIndex]) {
                searchIndex++;
            }
        }

        return searchIndex === this.searchQuery.length;
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

    dispose(): void {
        this.searchStatusBarItem.dispose();
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

        if (contextValue === 'searchBox' || contextValue === 'searchStatus') {
            this.iconPath = new vscode.ThemeIcon('search');
            // Make search box visually distinct
            this.resourceUri = vscode.Uri.parse('search://search');
        } else if (contextValue === 'separator') {
            // No icon for separator
            this.iconPath = undefined;
        } else if (contextValue === 'directory') {
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
        } else if (contextValue === 'searchBox' || contextValue === 'searchStatus') {
            this.command = {
                command: 'runmate.searchScripts',
                title: 'Search Scripts',
                arguments: []
            };
        }
    }
}
