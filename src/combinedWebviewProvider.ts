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
            localResourceRoots: [
                this._extensionUri,
                vscode.Uri.file(this.context.extensionPath)
            ]
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

                // Get file decoration/icon class based on file extension
                const fileExt = path.extname(script.name).toLowerCase();
                const isShellScript = ['.sh', '.bash', '.zsh', '.fish', '.ksh'].includes(fileExt) ||
                                     script.name.endsWith('.command');

                scriptList.push({
                    name: script.name,
                    path: script.path,
                    directory: dir === 'root' ? '/' : dir,
                    status: status,
                    isRunning: status === ExecutionStatus.Running,
                    fileType: isShellScript ? 'shell' : 'script',
                    fileExt: fileExt
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
        const seenPaths = new Set<string>();

        // Filter and organize logs
        for (const [dir, logs] of allLogs.entries()) {
            for (const log of logs) {
                if (seenPaths.has(log.path)) {
                    continue;
                }

                if (this.logSearchQuery && !this.matchesSearch(log.name, this.logSearchQuery)) {
                    continue;
                }

                seenPaths.add(log.path);

                // Get file decoration/icon class based on file extension
                const fileExt = path.extname(log.name).toLowerCase();
                const isLogFile = ['.log', '.out', '.err'].includes(fileExt);

                logList.push({
                    name: log.name,
                    path: log.path,
                    directory: dir === 'root' ? '/' : dir,
                    size: this.logScanner.formatFileSize(log.size),
                    fileType: isLogFile ? 'log' : 'text',
                    fileExt: fileExt
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

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Get the current file icon theme
        const fileIconTheme = vscode.workspace.getConfiguration().get('workbench.iconTheme', 'vs-seti');
        return this.getWebviewHTML(webview, fileIconTheme);
    }

    private getWebviewHTML(_webview: vscode.Webview, _iconTheme: string): string {
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
            <link href="https://microsoft.github.io/vscode-codicons/dist/codicon.css" rel="stylesheet" />
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                body {
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-sideBar-background);
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    overflow: hidden;
                }

                /* Tab Bar */
                .tab-bar {
                    display: flex;
                    background-color: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding: 0;
                    height: 35px;
                }

                .tab {
                    flex: 1;
                    padding: 8px 16px;
                    text-align: center;
                    cursor: pointer;
                    border: none;
                    background: transparent;
                    color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground));
                    font-size: 13px;
                    font-family: var(--vscode-font-family);
                    border-bottom: 2px solid transparent;
                    transition: all 0.2s ease;
                    min-height: 35px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .tab:hover {
                    color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
                    background-color: var(--vscode-tab-hoverBackground, var(--vscode-list-hoverBackground));
                }

                .tab.active {
                    color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
                    border-bottom-color: var(--vscode-tab-activeBorder, var(--vscode-focusBorder));
                    background-color: var(--vscode-tab-activeBackground, transparent);
                }

                .tab:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: -1px;
                }

                .tab .codicon {
                    font-size: 14px;
                    margin-right: 4px;
                    vertical-align: middle;
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
                    border-radius: 2px;
                    padding: 0 8px;
                    height: 26px;
                }

                .search-box:focus-within {
                    border-color: var(--vscode-focusBorder);
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: -1px;
                }

                .search-input {
                    flex: 1;
                    background: transparent;
                    border: none;
                    color: var(--vscode-input-foreground);
                    outline: none;
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                    line-height: 16px;
                }

                .search-input::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                }

                .clear-button {
                    background: transparent;
                    border: none;
                    color: var(--vscode-icon-foreground);
                    cursor: pointer;
                    padding: 2px;
                    font-size: 16px;
                    width: 16px;
                    height: 16px;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    border-radius: 2px;
                }

                .clear-button:hover {
                    background-color: var(--vscode-toolbar-hoverBackground);
                }

                .clear-button.visible {
                    display: flex;
                }

                .clear-button .codicon {
                    font-size: 14px;
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
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                }

                .terminal-actions {
                    display: flex;
                    gap: 4px;
                }

                .terminal-action-button {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-button-border, transparent);
                    padding: 4px 8px;
                    font-size: 11px;
                    font-family: var(--vscode-font-family);
                    border-radius: 2px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    min-height: 26px;
                }

                .terminal-action-button:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
                }

                .terminal-action-button:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: -1px;
                }

                .terminal-action-button .codicon {
                    font-size: 14px;
                    margin-right: 2px;
                }

                /* Content Area */
                .content-area {
                    flex: 1;
                    overflow-y: auto;
                    overflow-x: hidden;
                }

                .content-view {
                    display: none;
                }

                .content-view.active {
                    display: block;
                }

                /* Directory Groups */
                .directory-group {
                    margin-bottom: 0;
                }

                .directory-header {
                    display: flex;
                    align-items: center;
                    padding: 4px 8px;
                    cursor: pointer;
                    user-select: none;
                    min-height: 22px;
                    font-size: 13px;
                    color: var(--vscode-foreground);
                }

                .directory-header:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                /* Codicon chevron icons */
                .codicon-chevron-down::before {
                    content: '\\eab4';
                }

                .codicon-chevron-right::before {
                    content: '\\eab6';
                }

                .directory-arrow {
                    margin-right: 2px;
                    color: var(--vscode-icon-foreground);
                    font-size: 11px;
                    width: 16px;
                    height: 16px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                }

                .directory-header.collapsed .directory-arrow {
                    /* Arrow is rotated via class change instead */
                }

                .directory-name {
                    flex: 1;
                    font-weight: normal;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .directory-count {
                    color: var(--vscode-descriptionForeground);
                    font-size: 11px;
                    margin-left: 8px;
                }

                /* Items */
                .item {
                    display: flex;
                    align-items: center;
                    padding: 2px 8px 2px 24px;
                    cursor: pointer;
                    position: relative;
                    min-height: 22px;
                    font-size: 13px;
                }

                .item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .item-icon {
                    margin-right: 6px;
                    font-size: 16px;
                    width: 16px;
                    height: 16px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                /* Match VS Code's file icon styles */
                .file-icon {
                    font-family: var(--vscode-editor-font-family), 'Courier New', monospace;
                    font-size: 14px;
                    width: 16px;
                    text-align: center;
                }

                .file-icon.shell-file {
                    color: #89d185; /* Green for shell scripts */
                    font-weight: bold;
                }

                /* Codicon list-flat icon for log files (horizontal lines) */
                .codicon-list-flat::before {
                    content: '\\eb84';
                }

                .log-item .codicon-list-flat {
                    color: var(--vscode-icon-foreground);
                    opacity: 0.9;
                }

                .item-name {
                    flex: 1;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    color: var(--vscode-foreground);
                }

                .item-info {
                    display: flex;
                    gap: 8px;
                    color: var(--vscode-descriptionForeground);
                    font-size: 11px;
                    margin-right: 8px;
                }

                .item-actions {
                    display: none;
                    gap: 2px;
                }

                .item:hover .item-actions {
                    display: flex;
                }

                .action-button {
                    background: transparent;
                    border: none;
                    color: var(--vscode-icon-foreground);
                    cursor: pointer;
                    padding: 2px;
                    font-size: 16px;
                    width: 20px;
                    height: 20px;
                    border-radius: 2px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .action-button .codicon {
                    font-size: 16px;
                }

                .action-button:hover {
                    background-color: var(--vscode-toolbar-hoverBackground);
                }

                .action-button:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: -1px;
                }

                /* Script specific styles */
                .script-item.running .item-icon {
                    color: var(--vscode-progressBar-background, #0e70c0) !important;
                }

                .script-item.running .item-name {
                    color: var(--vscode-foreground);
                }

                /* Codicon animations */
                @keyframes codicon-spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }

                .codicon-modifier-spin {
                    animation: codicon-spin 1.5s linear infinite;
                }

                /* Empty state */
                .empty-state {
                    padding: 24px 16px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    font-size: 13px;
                }

                .directory-content {
                    display: block;
                }

                .directory-content.collapsed {
                    display: none;
                }

                /* Badge styles for status indicators */
                .status-badge {
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    font-size: 11px;
                    padding: 1px 6px;
                    border-radius: 11px;
                    margin-left: 4px;
                    white-space: nowrap;
                }

                /* Focus states for accessibility */
                .item:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: -1px;
                    background-color: var(--vscode-list-focusBackground, var(--vscode-list-hoverBackground));
                }

                .directory-header:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: -1px;
                }

                /* Scrollbar styling to match VS Code */
                ::-webkit-scrollbar {
                    width: 10px;
                }

                ::-webkit-scrollbar-track {
                    background: var(--vscode-scrollbarSlider-background);
                }

                ::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-background);
                    border-radius: 5px;
                }

                ::-webkit-scrollbar-thumb:hover {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                }

                ::-webkit-scrollbar-thumb:active {
                    background: var(--vscode-scrollbarSlider-activeBackground);
                }
            </style>`;
    }

    private getTabBar(): string {
        return `
            <div class="tab-bar">
                <button class="tab active" id="scriptsTab" onclick="switchTab('scripts')">
                    <span class="shell-icon" style="margin-right: 4px;">$</span> Scripts
                </button>
                <button class="tab" id="logsTab" onclick="switchTab('logs')">
                    <span class="codicon codicon-list-flat"></span> Logs
                </button>
            </div>`;
    }

    private getSearchContainer(): string {
        return `
            <div class="search-container">
                <div class="search-box">
                    <input
                        type="text"
                        class="search-input"
                        id="searchInput"
                        placeholder="Search..."
                    />
                    <button class="clear-button" id="clearButton" title="Clear"><span class="codicon codicon-close"></span></button>
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
                        <span class="codicon codicon-check"></span>
                        <span>Close Completed</span>
                    </button>
                    <button class="terminal-action-button" onclick="closeAllTerminals()" title="Close all terminals">
                        <span class="codicon codicon-close-all"></span>
                        <span>Close All</span>
                    </button>
                    <button class="terminal-action-button" onclick="showTerminalManager()" title="Manage terminals">
                        <span class="codicon codicon-settings-gear"></span>
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

                // Function to get appropriate file icon based on file type and theme
                function getFileIcon(fileName, fileType) {
                    const ext = fileName.split('.').pop().toLowerCase();

                    // Map file extensions to appropriate icons/symbols
                    const iconMap = {
                        // Shell scripts
                        'sh': '$',
                        'bash': '$',
                        'zsh': '$',
                        'fish': '$',
                        'ksh': '$',
                        'command': '$',
                        // Log files - use same icon as VS Code Explorer
                        'log': '',  // Will use codicon class instead
                        'out': '',  // Will use codicon class instead
                        'err': '',  // Will use codicon class instead
                        'txt': '',  // Will use codicon class instead
                        // Default
                        'default': ''
                    };

                    return iconMap[ext] || iconMap[fileType] || iconMap['default'];
                }

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
                            <div class="directory-header" id="header_\${dirId}" onclick="toggleDirectory('\${dirId}')">
                                <span class="directory-arrow codicon codicon-chevron-down"></span>
                                <span class="directory-name">\${dir}</span>
                            </div>
                            <div class="directory-content" id="\${dirId}">
                                \${dirScripts.map(script => renderScriptItem(script)).join('')}
                            </div>
                        </div>
                    \`;
                }

                function renderScriptItem(script) {
                    const statusClass = script.isRunning ? 'running' : '';

                    // Determine icon based on file type and current theme
                    let iconClass = '';
                    let iconContent = '';

                    if (script.isRunning) {
                        iconClass = 'codicon codicon-loading codicon-modifier-spin';
                    } else if (script.fileType === 'shell') {
                        // Use appropriate icon for shell scripts
                        iconClass = 'file-icon shell-file';
                        iconContent = getFileIcon(script.name, 'shell');
                    } else {
                        iconClass = 'file-icon script-file';
                        iconContent = getFileIcon(script.name, 'script');
                    }

                    return \`
                        <div class="item script-item \${statusClass}"
                             ondblclick="openScript('\${script.path}')"
                             title="\${script.path}">
                            <span class="item-icon \${iconClass}">\${iconContent}</span>
                            <span class="item-name">\${script.name}</span>
                            <div class="item-actions">
                                \${script.isRunning
                                    ? \`<button class="action-button" onclick="stopScript('\${script.path}', event)" title="Stop"><span class="codicon codicon-debug-stop"></span></button>\`
                                    : \`<button class="action-button" onclick="runScript('\${script.path}', event)" title="Run"><span class="codicon codicon-run"></span></button>\`
                                }
                                <button class="action-button" onclick="openScript('\${script.path}', event)" title="Open"><span class="codicon codicon-go-to-file"></span></button>
                                <button class="action-button" onclick="deleteScript('\${script.path}', event)" title="Delete"><span class="codicon codicon-trash"></span></button>
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
                            <div class="directory-header" id="header_\${dirId}" onclick="toggleDirectory('\${dirId}')">
                                <span class="directory-arrow codicon codicon-chevron-down"></span>
                                <span class="directory-name">\${dir}</span>
                            </div>
                            <div class="directory-content" id="\${dirId}">
                                \${dirLogs.map(log => renderLogItem(log)).join('')}
                            </div>
                        </div>
                    \`;
                }

                function renderLogItem(log) {
                    // Use codicon-list-flat for log files (horizontal lines icon)
                    const iconClass = 'codicon codicon-list-flat';

                    return \`
                        <div class="item log-item"
                             ondblclick="openLog('\${log.path}')"
                             title="\${log.path}">
                            <span class="item-icon \${iconClass}"></span>
                            <span class="item-name">\${log.name}</span>
                            <div class="item-info">
                                <span>\${log.size}</span>
                            </div>
                            <div class="item-actions">
                                <button class="action-button" onclick="openLog('\${log.path}', event)" title="Open"><span class="codicon codicon-go-to-file"></span></button>
                                <button class="action-button" onclick="deleteLog('\${log.path}', event)" title="Delete"><span class="codicon codicon-trash"></span></button>
                            </div>
                        </div>
                    \`;
                }

                // Common functions
                function toggleDirectory(dirId) {
                    const content = document.getElementById(dirId);
                    const header = document.getElementById('header_' + dirId);
                    if (content && header) {
                        content.classList.toggle('collapsed');
                        header.classList.toggle('collapsed');

                        // Update arrow icon
                        const arrow = header.querySelector('.directory-arrow');
                        if (arrow) {
                            if (content.classList.contains('collapsed')) {
                                arrow.classList.remove('codicon-chevron-down');
                                arrow.classList.add('codicon-chevron-right');
                            } else {
                                arrow.classList.remove('codicon-chevron-right');
                                arrow.classList.add('codicon-chevron-down');
                            }
                        }
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