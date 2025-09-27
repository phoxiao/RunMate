import * as vscode from 'vscode';
import { LogScanner } from './logScanner';
import * as path from 'path';

export class LogWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'runmate.logWebview';
    private _view?: vscode.WebviewView;
    private searchQuery: string = '';
    private activeTab: 'scripts' | 'logs' = 'scripts';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private logScanner: LogScanner,
        _context: vscode.ExtensionContext
    ) {
        // Listen for log changes
        this.logScanner.onLogsChanged(() => {
            this.updateLogList();
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'searchLogs':
                    this.searchQuery = data.value;
                    this.updateLogList();
                    break;
                case 'openLog':
                    await this.openLog(data.logPath);
                    break;
                case 'deleteLog':
                    await this.deleteLog(data.logPath);
                    break;
                case 'refreshLogs':
                    await this.logScanner.scanLogs();
                    this.updateLogList();
                    break;
                case 'switchTab':
                    this.activeTab = data.tab;
                    this.updateView();
                    break;
            }
        });

        // Initial load
        this.updateLogList();
    }

    private async openLog(logPath: string): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(logPath);
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open log file: ${error}`);
        }
    }

    private async deleteLog(logPath: string): Promise<void> {
        const logName = path.basename(logPath);

        // Show confirmation dialog
        const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to delete "${logName}"?`,
            { modal: true },
            'Delete',
            'Cancel'
        );

        if (confirmation !== 'Delete') {
            return;
        }

        try {
            await this.logScanner.deleteLog(logPath);
            vscode.window.showInformationMessage(`Successfully deleted: ${logName}`);
            this.updateLogList();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete log file: ${error}`);
        }
    }

    private updateLogList() {
        if (!this._view) {
            return;
        }

        const allLogs = this.logScanner.getLogs();
        const logList: any[] = [];

        // Filter and organize logs
        for (const [dir, logs] of allLogs.entries()) {
            for (const log of logs) {
                // Apply search filter
                if (this.searchQuery && !this.matchesSearch(log.name, this.searchQuery)) {
                    continue;
                }

                logList.push({
                    name: log.name,
                    path: log.path,
                    directory: dir === 'root' ? '/' : dir,
                    size: this.logScanner.formatFileSize(log.size)
                });
            }
        }

        // Send updated log list to webview
        this._view.webview.postMessage({
            type: 'updateLogs',
            logs: logList
        });
    }

    private updateView() {
        if (!this._view) {
            return;
        }

        this._view.webview.postMessage({
            type: 'switchTab',
            tab: this.activeTab
        });
    }

    private matchesSearch(filename: string, query: string): boolean {
        if (!query) return true;
        const lowerFilename = filename.toLowerCase();
        const lowerQuery = query.toLowerCase();
        return lowerFilename.includes(lowerQuery);
    }

    private _getHtmlForWebview(_webview: vscode.Webview) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-sideBar-background);
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                }

                /* Tab Bar */
                .tab-bar {
                    display: flex;
                    background-color: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding: 0;
                }

                .tab {
                    flex: 1;
                    padding: 8px 12px;
                    text-align: center;
                    cursor: pointer;
                    border-bottom: 2px solid transparent;
                    transition: all 0.2s;
                    background: transparent;
                    border: none;
                    color: var(--vscode-foreground);
                    opacity: 0.7;
                }

                .tab:hover {
                    opacity: 1;
                    background-color: var(--vscode-list-hoverBackground);
                }

                .tab.active {
                    opacity: 1;
                    border-bottom-color: var(--vscode-activityBar-activeBorder);
                }

                /* Search Container */
                .search-container {
                    padding: 8px;
                    background-color: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }

                .search-box {
                    display: flex;
                    align-items: center;
                    background-color: var(--vscode-input-background);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                    padding: 0 8px;
                    height: 32px;
                }

                .search-box:focus-within {
                    border-color: var(--vscode-focusBorder);
                }

                .search-icon {
                    color: var(--vscode-foreground);
                    opacity: 0.5;
                    margin-right: 6px;
                }

                .search-input {
                    flex: 1;
                    background: transparent;
                    border: none;
                    color: var(--vscode-input-foreground);
                    outline: none;
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                }

                .search-input::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                }

                /* Log List */
                .log-list {
                    flex: 1;
                    overflow-y: auto;
                    padding: 4px 0;
                }

                .directory-group {
                    margin-bottom: 4px;
                }

                .directory-header {
                    display: flex;
                    align-items: center;
                    padding: 6px 8px;
                    cursor: pointer;
                    user-select: none;
                    background-color: var(--vscode-sideBarSectionHeader-background);
                }

                .directory-header:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .directory-icon {
                    margin-right: 6px;
                    opacity: 0.8;
                }

                .directory-name {
                    flex: 1;
                    font-weight: 500;
                }

                .directory-count {
                    opacity: 0.6;
                    font-size: 12px;
                }

                .log-item {
                    display: flex;
                    align-items: center;
                    padding: 4px 8px 4px 24px;
                    cursor: pointer;
                    position: relative;
                }

                .log-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .log-icon {
                    margin-right: 6px;
                    opacity: 0.8;
                }

                .log-name {
                    flex: 1;
                }

                .log-info {
                    display: flex;
                    gap: 12px;
                    opacity: 0.6;
                    font-size: 11px;
                }

                .log-actions {
                    display: none;
                    gap: 4px;
                    margin-left: 8px;
                }

                .log-item:hover .log-actions {
                    display: flex;
                }

                .action-button {
                    background: transparent;
                    border: none;
                    color: var(--vscode-foreground);
                    opacity: 0.6;
                    cursor: pointer;
                    padding: 2px 4px;
                    font-size: 14px;
                    border-radius: 2px;
                }

                .action-button:hover {
                    opacity: 1;
                    background-color: var(--vscode-toolbar-hoverBackground);
                }

                /* Empty state */
                .empty-state {
                    padding: 20px;
                    text-align: center;
                    opacity: 0.6;
                }

                .directory-content {
                    display: block;
                }

                .directory-content.collapsed {
                    display: none;
                }
            </style>
        </head>
        <body>
            <div class="tab-bar">
                <button class="tab active" id="scriptsTab" onclick="switchTab('scripts')">
                    Scripts
                </button>
                <button class="tab" id="logsTab" onclick="switchTab('logs')">
                    Logs
                </button>
            </div>

            <div class="search-container">
                <div class="search-box">
                    <span class="search-icon">🔍</span>
                    <input
                        type="text"
                        class="search-input"
                        placeholder="Search logs..."
                        id="searchInput"
                    />
                </div>
            </div>

            <div class="log-list" id="logList">
                <div class="empty-state">Loading logs...</div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const searchInput = document.getElementById('searchInput');
                const logList = document.getElementById('logList');
                let logs = [];
                let groupedLogs = {};

                // Handle search input
                let searchTimeout;
                searchInput.addEventListener('input', (e) => {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(() => {
                        vscode.postMessage({
                            type: 'searchLogs',
                            value: e.target.value
                        });
                    }, 200);
                });

                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'updateLogs':
                            logs = message.logs;
                            renderLogs();
                            break;
                        case 'switchTab':
                            updateActiveTab(message.tab);
                            break;
                    }
                });

                function renderLogs() {
                    if (logs.length === 0) {
                        logList.innerHTML = '<div class="empty-state">No log files found</div>';
                        return;
                    }

                    // Group logs by directory
                    groupedLogs = {};
                    logs.forEach(log => {
                        if (!groupedLogs[log.directory]) {
                            groupedLogs[log.directory] = [];
                        }
                        groupedLogs[log.directory].push(log);
                    });

                    // Render grouped logs
                    let html = '';
                    Object.keys(groupedLogs).sort().forEach(dir => {
                        const dirLogs = groupedLogs[dir];
                        html += renderDirectory(dir, dirLogs);
                    });

                    logList.innerHTML = html;
                }

                function renderDirectory(dir, dirLogs) {
                    const dirId = 'dir_' + dir.replace(/[^a-zA-Z0-9]/g, '_');
                    return \`
                        <div class="directory-group">
                            <div class="directory-header" onclick="toggleDirectory('\${dirId}')">
                                <span class="directory-icon">📁</span>
                                <span class="directory-name">\${dir}/</span>
                                <span class="directory-count">(\${dirLogs.length} files)</span>
                            </div>
                            <div class="directory-content" id="\${dirId}">
                                \${dirLogs.map(log => renderLogItem(log)).join('')}
                            </div>
                        </div>
                    \`;
                }

                function renderLogItem(log) {
                    return \`
                        <div class="log-item"
                             ondblclick="openLog('\${log.path}')"
                             title="\${log.path}">
                            <span class="log-icon">📄</span>
                            <span class="log-name">\${log.name}</span>
                            <div class="log-info">
                                <span>\${log.size}</span>
                            </div>
                            <div class="log-actions">
                                <button class="action-button" onclick="openLog('\${log.path}', event)" title="Open">📝</button>
                                <button class="action-button" onclick="deleteLog('\${log.path}', event)" title="Delete">🗑️</button>
                            </div>
                        </div>
                    \`;
                }

                function toggleDirectory(dirId) {
                    const content = document.getElementById(dirId);
                    if (content) {
                        content.classList.toggle('collapsed');
                    }
                }

                function openLog(path, event) {
                    if (event) event.stopPropagation();
                    vscode.postMessage({ type: 'openLog', logPath: path });
                }

                function deleteLog(path, event) {
                    if (event) event.stopPropagation();
                    vscode.postMessage({ type: 'deleteLog', logPath: path });
                }

                function switchTab(tab) {
                    vscode.postMessage({ type: 'switchTab', tab: tab });
                }

                function updateActiveTab(tab) {
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    if (tab === 'scripts') {
                        document.getElementById('scriptsTab').classList.add('active');
                    } else {
                        document.getElementById('logsTab').classList.add('active');
                    }
                }

                // Request initial data
                vscode.postMessage({ type: 'refreshLogs' });
            </script>
        </body>
        </html>`;
    }

    public refresh(): void {
        this.updateLogList();
    }
}