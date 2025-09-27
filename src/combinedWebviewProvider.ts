import * as vscode from 'vscode';
import { ScriptScanner } from './scriptScanner';
import { LogScanner } from './logScanner';
import { Executor, ExecutionStatus } from './executor';
import * as path from 'path';

export class CombinedWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'runmate.scriptWebview';
    private _view?: vscode.WebviewView;
    private scriptSearchQuery: string = '';
    private logSearchQuery: string = '';
    private activeTab: 'scripts' | 'logs' = 'scripts';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private scriptScanner: ScriptScanner,
        private logScanner: LogScanner,
        private executor: Executor,
        private context: vscode.ExtensionContext
    ) {
        // Listen for script status changes
        this.executor.onStatusChanged(() => {
            if (this.activeTab === 'scripts') {
                this.updateScriptList();
            }
        });

        // Listen for log changes
        this.logScanner.onLogsChanged(() => {
            if (this.activeTab === 'logs') {
                this.updateLogList();
            }
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
                // Tab switching
                case 'switchTab':
                    this.activeTab = data.tab;
                    if (this.activeTab === 'scripts') {
                        this.updateScriptList();
                    } else {
                        this.updateLogList();
                    }
                    break;

                // Script commands
                case 'searchScripts':
                    this.scriptSearchQuery = data.value;
                    this.updateScriptList();
                    break;
                case 'runScript':
                    await this.runScript(data.scriptPath);
                    break;
                case 'stopScript':
                    await this.executor.stopScript(data.scriptPath);
                    break;
                case 'openScript':
                    const scriptDoc = await vscode.workspace.openTextDocument(data.scriptPath);
                    await vscode.window.showTextDocument(scriptDoc);
                    break;
                case 'refreshScripts':
                    await this.scriptScanner.scanScripts();
                    this.updateScriptList();
                    break;
                case 'deleteScript':
                    await this.deleteScript(data.scriptPath);
                    break;

                // Log commands
                case 'searchLogs':
                    this.logSearchQuery = data.value;
                    this.updateLogList();
                    break;
                case 'openLog':
                    const logDoc = await vscode.workspace.openTextDocument(data.logPath);
                    await vscode.window.showTextDocument(logDoc);
                    break;
                case 'deleteLog':
                    await this.deleteLog(data.logPath);
                    break;
                case 'refreshLogs':
                    await this.logScanner.scanLogs();
                    this.updateLogList();
                    break;

                // Terminal commands
                case 'closeAllTerminals':
                    this.executor.getTerminalManager().closeAllTerminals();
                    this.updateScriptList();
                    break;
                case 'closeCompletedTerminals':
                    this.executor.getTerminalManager().closeCompletedTerminals();
                    this.updateScriptList();
                    break;
                case 'showTerminalManager':
                    vscode.commands.executeCommand('runmate.showTerminalManager');
                    break;
            }
        });

        // Initial load based on active tab
        if (this.activeTab === 'scripts') {
            this.updateScriptList();
        } else {
            this.updateLogList();
        }
    }

    private async runScript(scriptPath: string): Promise<void> {
        const scriptName = path.basename(scriptPath);
        const config = vscode.workspace.getConfiguration('runmate');
        let parameters = '';

        // Check if script has parameters
        const hasParams = this.executor.hasParameters(scriptPath);

        // Get last parameters if remember is enabled and script has parameters
        if (hasParams && config.get<boolean>('rememberLastParameters')) {
            const lastParams = this.context.workspaceState.get<string>(`params_${scriptPath}`);
            if (lastParams) {
                parameters = lastParams;
            }
        }

        // Show unified dialog for confirmation and parameter input
        const confirmExecution = config.get<boolean>('confirmBeforeExecute', true);
        if (confirmExecution || hasParams) {
            let dialogResult: string | undefined;

            if (hasParams) {
                dialogResult = await vscode.window.showInputBox({
                    prompt: `Execute script: ${scriptName}`,
                    placeHolder: 'Enter parameters (optional) and press Enter to execute, or Esc to cancel',
                    value: parameters,
                    validateInput: (_value) => null,
                    ignoreFocusOut: true
                });

                if (dialogResult === undefined) {
                    return;
                }

                parameters = dialogResult;

                if (config.get<boolean>('rememberLastParameters') && parameters) {
                    await this.context.workspaceState.update(`params_${scriptPath}`, parameters);
                }
            } else {
                const confirmation = await vscode.window.showQuickPick(
                    [
                        { label: '$(play) Execute', description: scriptPath },
                        { label: '$(x) Cancel', description: 'Cancel execution' }
                    ],
                    {
                        placeHolder: `Execute script: ${scriptName}?`,
                        ignoreFocusOut: true
                    }
                );

                if (!confirmation || confirmation.label.includes('Cancel')) {
                    return;
                }
            }
        }

        await this.executor.executeScript(scriptPath, parameters || '');
    }

    private async deleteScript(scriptPath: string): Promise<void> {
        const scriptName = path.basename(scriptPath);

        const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to delete "${scriptName}"?`,
            { modal: true },
            'Delete',
            'Cancel'
        );

        if (confirmation !== 'Delete') {
            return;
        }

        try {
            const fileUri = vscode.Uri.file(scriptPath);
            await vscode.workspace.fs.delete(fileUri);
            vscode.window.showInformationMessage(`Successfully deleted: ${scriptName}`);
            await this.scriptScanner.scanScripts();
            this.updateScriptList();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete script: ${error}`);
        }
    }

    private async deleteLog(logPath: string): Promise<void> {
        const logName = path.basename(logPath);

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
            vscode.window.showErrorMessage(`Failed to delete log: ${error}`);
        }
    }

    private updateScriptList() {
        if (!this._view) {
            return;
        }

        const allScripts = this.scriptScanner.getScripts();
        const scriptList: any[] = [];
        const seenPaths = new Set<string>();

        // Filter and organize scripts
        for (const [dir, scripts] of allScripts.entries()) {
            for (const script of scripts) {
                if (seenPaths.has(script.path)) {
                    continue;
                }

                if (this.scriptSearchQuery && !this.matchesSearch(script.name, this.scriptSearchQuery)) {
                    continue;
                }

                seenPaths.add(script.path);
                const status = this.executor.getScriptStatus(script.path);
                scriptList.push({
                    name: script.name,
                    path: script.path,
                    directory: dir === 'root' ? '/' : dir,
                    status: status,
                    isRunning: status === ExecutionStatus.Running
                });
            }
        }

        // Get terminal counts for status display
        const terminalCounts = this.executor.getTerminalManager().getTerminalCounts();

        // Send updated script list to webview
        this._view.webview.postMessage({
            type: 'updateScripts',
            scripts: scriptList,
            terminalCounts: terminalCounts
        });
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
                if (this.logSearchQuery && !this.matchesSearch(log.name, this.logSearchQuery)) {
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

    private matchesSearch(filename: string, query: string): boolean {
        if (!query) return true;
        const lowerFilename = filename.toLowerCase();
        const lowerQuery = query.toLowerCase();

        // Check for fuzzy match
        let searchIndex = 0;
        for (let i = 0; i < lowerFilename.length && searchIndex < lowerQuery.length; i++) {
            if (lowerFilename[i] === lowerQuery[searchIndex]) {
                searchIndex++;
            }
        }

        return searchIndex === lowerQuery.length;
    }

    private _getHtmlForWebview(_webview: vscode.Webview) {
        return this.getWebviewHTML();
    }

    private getWebviewHTML(): string {
        // Return combined HTML with tabs for scripts and logs
        // This is a simplified version - you would expand this with full HTML
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            ${this.getStyles()}
        </head>
        <body>
            ${this.getTabBar()}
            ${this.getSearchContainer()}
            ${this.getTerminalBar()}
            ${this.getContentArea()}
            ${this.getScripts()}
        </body>
        </html>`;
    }

    private getStyles(): string {
        return `
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
                    font-size: var(--vscode-font-size);
                }

                .tab:hover {
                    opacity: 1;
                    background-color: var(--vscode-list-hoverBackground);
                }

                .tab.active {
                    opacity: 1;
                    border-bottom-color: var(--vscode-activityBar-activeBorder);
                    background-color: var(--vscode-list-activeSelectionBackground);
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
                    font-size: 14px;
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

                .clear-button {
                    background: transparent;
                    border: none;
                    color: var(--vscode-foreground);
                    opacity: 0.5;
                    cursor: pointer;
                    padding: 0 4px;
                    font-size: 18px;
                    display: none;
                }

                .clear-button:hover {
                    opacity: 1;
                }

                .clear-button.visible {
                    display: block;
                }

                /* Terminal Bar */
                .terminal-bar {
                    padding: 8px;
                    background-color: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: none;
                }

                .terminal-bar.visible {
                    display: block;
                }

                .terminal-info {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 8px;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }

                .terminal-actions {
                    display: flex;
                    gap: 4px;
                }

                .terminal-action-button {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-button-border);
                    padding: 4px 8px;
                    font-size: 11px;
                    border-radius: 2px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }

                .terminal-action-button:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
                }

                /* Content Area */
                .content-area {
                    flex: 1;
                    overflow-y: auto;
                    padding: 4px 0;
                }

                .content-view {
                    display: none;
                }

                .content-view.active {
                    display: block;
                }

                /* Directory Groups */
                .directory-group {
                    margin-bottom: 4px;
                }

                .directory-header {
                    display: flex;
                    align-items: center;
                    padding: 6px 8px;
                    cursor: pointer;
                    user-select: none;
                    min-height: 24px;
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

                /* Items */
                .item {
                    display: flex;
                    align-items: center;
                    padding: 3px 8px 3px 24px;
                    cursor: pointer;
                    position: relative;
                    min-height: 24px;
                }

                .item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .item-icon {
                    margin-right: 6px;
                    opacity: 0.8;
                    font-size: 14px;
                }

                .item-name {
                    flex: 1;
                }

                .item-info {
                    display: flex;
                    gap: 12px;
                    opacity: 0.6;
                    font-size: 11px;
                    margin-right: 8px;
                }

                .item-actions {
                    display: none;
                    gap: 4px;
                }

                .item:hover .item-actions {
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

                /* Script specific styles */
                .script-item.running .item-icon {
                    animation: spin 1s linear infinite;
                }

                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
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
            </style>`;
    }

    private getTabBar(): string {
        return `
            <div class="tab-bar">
                <button class="tab active" id="scriptsTab" onclick="switchTab('scripts')">
                    📜 Scripts
                </button>
                <button class="tab" id="logsTab" onclick="switchTab('logs')">
                    📄 Logs
                </button>
            </div>`;
    }

    private getSearchContainer(): string {
        return `
            <div class="search-container">
                <div class="search-box">
                    <span class="search-icon">🔍</span>
                    <input
                        type="text"
                        class="search-input"
                        id="searchInput"
                        placeholder="Search..."
                    />
                    <button class="clear-button" id="clearButton" title="Clear">×</button>
                </div>
            </div>`;
    }

    private getTerminalBar(): string {
        return `
            <div class="terminal-bar" id="terminalBar">
                <div class="terminal-info">
                    <span id="terminalCount">No terminals open</span>
                </div>
                <div class="terminal-actions">
                    <button class="terminal-action-button" onclick="closeCompletedTerminals()" title="Close completed terminals">
                        <span>✓</span>
                        <span>Close Completed</span>
                    </button>
                    <button class="terminal-action-button" onclick="closeAllTerminals()" title="Close all terminals">
                        <span>✕</span>
                        <span>Close All</span>
                    </button>
                    <button class="terminal-action-button" onclick="showTerminalManager()" title="Manage terminals">
                        <span>⚙</span>
                        <span>Manage</span>
                    </button>
                </div>
            </div>`;
    }

    private getContentArea(): string {
        return `
            <div class="content-area">
                <div class="content-view active" id="scriptsView">
                    <div class="empty-state">Loading scripts...</div>
                </div>
                <div class="content-view" id="logsView">
                    <div class="empty-state">Loading logs...</div>
                </div>
            </div>`;
    }

    private getScripts(): string {
        return `
            <script>
                const vscode = acquireVsCodeApi();
                let currentTab = 'scripts';
                let scripts = [];
                let logs = [];
                let groupedScripts = {};
                let groupedLogs = {};

                const searchInput = document.getElementById('searchInput');
                const clearButton = document.getElementById('clearButton');
                const scriptsView = document.getElementById('scriptsView');
                const logsView = document.getElementById('logsView');

                // Search handling
                let searchTimeout;
                searchInput.addEventListener('input', (e) => {
                    clearTimeout(searchTimeout);
                    updateClearButton();
                    searchTimeout = setTimeout(() => {
                        const messageType = currentTab === 'scripts' ? 'searchScripts' : 'searchLogs';
                        vscode.postMessage({
                            type: messageType,
                            value: e.target.value
                        });
                    }, 200);
                });

                clearButton.addEventListener('click', () => {
                    searchInput.value = '';
                    updateClearButton();
                    const messageType = currentTab === 'scripts' ? 'searchScripts' : 'searchLogs';
                    vscode.postMessage({
                        type: messageType,
                        value: ''
                    });
                });

                function updateClearButton() {
                    if (searchInput.value) {
                        clearButton.classList.add('visible');
                    } else {
                        clearButton.classList.remove('visible');
                    }
                }

                // Tab switching
                function switchTab(tab) {
                    currentTab = tab;

                    // Update tab UI
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    document.getElementById(tab + 'Tab').classList.add('active');

                    // Update content views
                    document.querySelectorAll('.content-view').forEach(v => v.classList.remove('active'));
                    document.getElementById(tab + 'View').classList.add('active');

                    // Update search placeholder
                    searchInput.placeholder = tab === 'scripts' ? 'Search scripts...' : 'Search logs...';
                    searchInput.value = '';
                    updateClearButton();

                    // Show/hide terminal bar for scripts tab
                    if (tab === 'scripts') {
                        document.getElementById('terminalBar').style.display = '';
                    } else {
                        document.getElementById('terminalBar').style.display = 'none';
                    }

                    // Send message to extension
                    vscode.postMessage({ type: 'switchTab', tab: tab });

                    // Request refresh
                    const refreshType = tab === 'scripts' ? 'refreshScripts' : 'refreshLogs';
                    vscode.postMessage({ type: refreshType });
                }

                // Message handler
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'updateScripts':
                            scripts = message.scripts;
                            updateTerminalBar(message.terminalCounts);
                            renderScripts();
                            break;
                        case 'updateLogs':
                            logs = message.logs;
                            renderLogs();
                            break;
                    }
                });

                // Scripts rendering
                function renderScripts() {
                    if (scripts.length === 0) {
                        scriptsView.innerHTML = '<div class="empty-state">No scripts found</div>';
                        return;
                    }

                    groupedScripts = {};
                    scripts.forEach(script => {
                        if (!groupedScripts[script.directory]) {
                            groupedScripts[script.directory] = [];
                        }
                        groupedScripts[script.directory].push(script);
                    });

                    let html = '';
                    Object.keys(groupedScripts).sort().forEach(dir => {
                        const dirScripts = groupedScripts[dir];
                        html += renderScriptDirectory(dir, dirScripts);
                    });

                    scriptsView.innerHTML = html;
                }

                function renderScriptDirectory(dir, dirScripts) {
                    const dirId = 'script_dir_' + dir.replace(/[^a-zA-Z0-9]/g, '_');
                    return \`
                        <div class="directory-group">
                            <div class="directory-header" onclick="toggleDirectory('\${dirId}')">
                                <span class="directory-icon">📁</span>
                                <span class="directory-name">\${dir}/</span>
                            </div>
                            <div class="directory-content" id="\${dirId}">
                                \${dirScripts.map(script => renderScriptItem(script)).join('')}
                            </div>
                        </div>
                    \`;
                }

                function renderScriptItem(script) {
                    const statusClass = script.isRunning ? 'running' : '';
                    const icon = script.isRunning ? '⟳' : '📜';

                    return \`
                        <div class="item script-item \${statusClass}"
                             ondblclick="openScript('\${script.path}')"
                             title="\${script.path}">
                            <span class="item-icon">\${icon}</span>
                            <span class="item-name">\${script.name}</span>
                            <div class="item-actions">
                                \${script.isRunning
                                    ? \`<button class="action-button" onclick="stopScript('\${script.path}', event)" title="Stop">⬜</button>\`
                                    : \`<button class="action-button" onclick="runScript('\${script.path}', event)" title="Run">▶</button>\`
                                }
                                <button class="action-button" onclick="openScript('\${script.path}', event)" title="Open">📝</button>
                                <button class="action-button" onclick="deleteScript('\${script.path}', event)" title="Delete">🗑️</button>
                            </div>
                        </div>
                    \`;
                }

                // Logs rendering
                function renderLogs() {
                    if (logs.length === 0) {
                        logsView.innerHTML = '<div class="empty-state">No log files found</div>';
                        return;
                    }

                    groupedLogs = {};
                    logs.forEach(log => {
                        if (!groupedLogs[log.directory]) {
                            groupedLogs[log.directory] = [];
                        }
                        groupedLogs[log.directory].push(log);
                    });

                    let html = '';
                    Object.keys(groupedLogs).sort().forEach(dir => {
                        const dirLogs = groupedLogs[dir];
                        html += renderLogDirectory(dir, dirLogs);
                    });

                    logsView.innerHTML = html;
                }

                function renderLogDirectory(dir, dirLogs) {
                    const dirId = 'log_dir_' + dir.replace(/[^a-zA-Z0-9]/g, '_');
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
                        <div class="item log-item"
                             ondblclick="openLog('\${log.path}')"
                             title="\${log.path}">
                            <span class="item-icon">📄</span>
                            <span class="item-name">\${log.name}</span>
                            <div class="item-info">
                                <span>\${log.size}</span>
                            </div>
                            <div class="item-actions">
                                <button class="action-button" onclick="openLog('\${log.path}', event)" title="Open">📝</button>
                                <button class="action-button" onclick="deleteLog('\${log.path}', event)" title="Delete">🗑️</button>
                            </div>
                        </div>
                    \`;
                }

                // Common functions
                function toggleDirectory(dirId) {
                    const content = document.getElementById(dirId);
                    if (content) {
                        content.classList.toggle('collapsed');
                    }
                }

                // Script actions
                function runScript(path, event) {
                    if (event) event.stopPropagation();
                    vscode.postMessage({ type: 'runScript', scriptPath: path });
                }

                function stopScript(path, event) {
                    if (event) event.stopPropagation();
                    vscode.postMessage({ type: 'stopScript', scriptPath: path });
                }

                function openScript(path, event) {
                    if (event) event.stopPropagation();
                    vscode.postMessage({ type: 'openScript', scriptPath: path });
                }

                function deleteScript(path, event) {
                    if (event) event.stopPropagation();
                    vscode.postMessage({ type: 'deleteScript', scriptPath: path });
                }

                // Log actions
                function openLog(path, event) {
                    if (event) event.stopPropagation();
                    vscode.postMessage({ type: 'openLog', logPath: path });
                }

                function deleteLog(path, event) {
                    if (event) event.stopPropagation();
                    vscode.postMessage({ type: 'deleteLog', logPath: path });
                }

                // Terminal actions
                function closeAllTerminals() {
                    vscode.postMessage({ type: 'closeAllTerminals' });
                }

                function closeCompletedTerminals() {
                    vscode.postMessage({ type: 'closeCompletedTerminals' });
                }

                function showTerminalManager() {
                    vscode.postMessage({ type: 'showTerminalManager' });
                }

                function updateTerminalBar(counts) {
                    const terminalBar = document.getElementById('terminalBar');
                    const terminalCount = document.getElementById('terminalCount');

                    if (!counts || counts.total === 0) {
                        terminalBar.classList.remove('visible');
                        return;
                    }

                    terminalBar.classList.add('visible');

                    let text = 'Terminals: ' + counts.total;
                    const parts = [];

                    if (counts.running > 0) {
                        parts.push(counts.running + ' running');
                    }
                    if (counts.completed > 0) {
                        parts.push(counts.completed + ' completed');
                    }
                    if (counts.failed > 0) {
                        parts.push(counts.failed + ' failed');
                    }

                    if (parts.length > 0) {
                        text += ' (' + parts.join(', ') + ')';
                    }

                    terminalCount.textContent = text;
                }

                // Initial setup
                updateClearButton();
                vscode.postMessage({ type: 'refreshScripts' });
            </script>`;
    }

    public refresh(): void {
        if (this.activeTab === 'scripts') {
            this.updateScriptList();
        } else {
            this.updateLogList();
        }
    }
}