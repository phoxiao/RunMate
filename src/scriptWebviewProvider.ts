import * as vscode from 'vscode';
import { ScriptScanner } from './scriptScanner';
import { Executor, ExecutionStatus } from './executor';
import * as path from 'path';

export class ScriptWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'runmate.scriptWebview';
    private _view?: vscode.WebviewView;
    private searchQuery: string = '';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private scriptScanner: ScriptScanner,
        private executor: Executor,
        private context: vscode.ExtensionContext
    ) {
        // Listen for script status changes
        this.executor.onStatusChanged(() => {
            this.updateScriptList();
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
                case 'search':
                    this.searchQuery = data.value;
                    this.updateScriptList();
                    break;
                case 'runScript':
                    await this.runScript(data.scriptPath);
                    break;
                case 'stopScript':
                    await this.executor.stopScript(data.scriptPath);
                    break;
                case 'openScript':
                    const doc = await vscode.workspace.openTextDocument(data.scriptPath);
                    await vscode.window.showTextDocument(doc);
                    break;
                case 'refresh':
                    await this.scriptScanner.scanScripts();
                    this.updateScriptList();
                    break;
            }
        });

        // Initial load
        this.updateScriptList();
    }

    private async runScript(scriptPath: string): Promise<void> {
        const scriptName = path.basename(scriptPath);
        const config = vscode.workspace.getConfiguration('runmate');
        let parameters = '';

        // Check if script has parameters
        const hasParams = this.executor.hasParameters(scriptPath);
        console.log(`RunMate WebView: Script ${scriptName} hasParams: ${hasParams}`);

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
            // Create the dialog based on whether script has parameters
            let dialogResult: string | undefined;

            if (hasParams) {
                // Show input box with confirmation options
                dialogResult = await vscode.window.showInputBox({
                    prompt: `Execute script: ${scriptName}`,
                    placeHolder: 'Enter parameters (optional) and press Enter to execute, or Esc to cancel',
                    value: parameters,
                    validateInput: (_value) => {
                        // Allow any input including empty string
                        return null;
                    },
                    ignoreFocusOut: true
                });

                if (dialogResult === undefined) {
                    // User cancelled
                    return;
                }

                parameters = dialogResult;

                // Save parameters if remember is enabled
                if (config.get<boolean>('rememberLastParameters') && parameters) {
                    await this.context.workspaceState.update(`params_${scriptPath}`, parameters);
                }
            } else {
                // No parameters needed, just show confirmation
                const confirmation = await vscode.window.showQuickPick(
                    [
                        {
                            label: '$(play) Execute',
                            description: scriptPath
                        },
                        {
                            label: '$(x) Cancel',
                            description: 'Cancel execution'
                        }
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
        } else {
            // No confirmation needed and no parameters, execute directly
            if (hasParams) {
                // Should not happen, but handle it anyway
                parameters = '';
            }
        }

        await this.executor.executeScript(scriptPath, parameters || '');
    }

    private updateScriptList() {
        if (!this._view) {
            return;
        }

        const allScripts = this.scriptScanner.getScripts();
        const scriptList: any[] = [];
        const seenPaths = new Set<string>();

        // Filter and organize scripts, avoiding duplicates
        for (const [dir, scripts] of allScripts.entries()) {
            for (const script of scripts) {
                // Skip if we've already seen this script
                if (seenPaths.has(script.path)) {
                    continue;
                }

                // Apply search filter
                if (this.searchQuery && !this.matchesSearch(script.name, this.searchQuery)) {
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

        // Send updated script list to webview
        this._view.webview.postMessage({
            type: 'updateScripts',
            scripts: scriptList
        });
    }

    private matchesSearch(filename: string, query: string): boolean {
        if (!query) return true;
        const lowerFilename = filename.toLowerCase();
        const lowerQuery = query.toLowerCase();
        let searchIndex = 0;

        for (let i = 0; i < lowerFilename.length && searchIndex < lowerQuery.length; i++) {
            if (lowerFilename[i] === lowerQuery[searchIndex]) {
                searchIndex++;
            }
        }

        return searchIndex === lowerQuery.length;
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

                /* Search Container */
                .search-container {
                    padding: 8px;
                    background-color: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    position: sticky;
                    top: 0;
                    z-index: 100;
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
                    line-height: 1;
                    display: flex;
                    align-items: center;
                }

                .search-input {
                    flex: 1;
                    background: transparent;
                    border: none;
                    color: var(--vscode-input-foreground);
                    outline: none;
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    padding: 0;
                    margin: 0;
                    height: 100%;
                    line-height: normal;
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
                    line-height: 1;
                    height: 100%;
                    align-items: center;
                    justify-content: center;
                }

                .clear-button:hover {
                    opacity: 1;
                }

                .clear-button.visible {
                    display: block;
                }

                /* Script List */
                .script-list {
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
                    min-height: 24px;
                }

                .directory-header:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .directory-icon {
                    margin-right: 6px;
                    opacity: 0.8;
                    line-height: 1;
                    display: flex;
                    align-items: center;
                    height: 16px;
                    font-size: 14px;
                }

                .directory-name {
                    flex: 1;
                    font-weight: 500;
                    line-height: 1.4;
                    display: flex;
                    align-items: center;
                }

                .script-item {
                    display: flex;
                    align-items: center;
                    padding: 3px 8px 3px 24px;
                    cursor: pointer;
                    position: relative;
                    min-height: 24px;
                }

                .script-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .script-icon {
                    margin-right: 6px;
                    opacity: 0.8;
                    font-size: 14px;
                    line-height: 1;
                    display: flex;
                    align-items: center;
                    height: 16px;
                }

                .script-name {
                    flex: 1;
                    line-height: 1.4;
                    display: flex;
                    align-items: center;
                }

                .script-actions {
                    display: none;
                    gap: 4px;
                }

                .script-item:hover .script-actions {
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

                /* Status indicators */
                .script-item.running .script-icon {
                    color: var(--vscode-progressBar-background);
                    animation: spin 1s linear infinite;
                }

                .script-item.success .script-icon {
                    color: var(--vscode-testing-iconPassed);
                }

                .script-item.failed .script-icon {
                    color: var(--vscode-testing-iconFailed);
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

            </style>
        </head>
        <body>
            <div class="search-container">
                <div class="search-box">
                    <span class="search-icon">🔍</span>
                    <input
                        type="text"
                        class="search-input"
                        placeholder="Type to search scripts"
                        id="searchInput"
                    />
                    <button class="clear-button" id="clearButton" title="Clear search">×</button>
                </div>
            </div>

            <div class="script-list" id="scriptList">
                <div class="empty-state">Loading scripts...</div>
            </div>


            <script>
                const vscode = acquireVsCodeApi();
                const searchInput = document.getElementById('searchInput');
                const clearButton = document.getElementById('clearButton');
                const scriptList = document.getElementById('scriptList');
                let scripts = [];
                let groupedScripts = {};

                // Update clear button visibility
                function updateClearButton() {
                    if (searchInput.value) {
                        clearButton.classList.add('visible');
                    } else {
                        clearButton.classList.remove('visible');
                    }
                }

                // Handle search input
                let searchTimeout;
                searchInput.addEventListener('input', (e) => {
                    clearTimeout(searchTimeout);
                    updateClearButton();
                    searchTimeout = setTimeout(() => {
                        vscode.postMessage({
                            type: 'search',
                            value: e.target.value
                        });
                    }, 200);
                });

                // Handle clear button
                clearButton.addEventListener('click', () => {
                    searchInput.value = '';
                    updateClearButton();
                    vscode.postMessage({
                        type: 'search',
                        value: ''
                    });
                });

                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'updateScripts':
                            scripts = message.scripts;
                            renderScripts();
                            break;
                    }
                });

                function renderScripts() {
                    if (scripts.length === 0) {
                        scriptList.innerHTML = '<div class="empty-state">No scripts found</div>';
                        return;
                    }

                    // Group scripts by directory
                    groupedScripts = {};
                    scripts.forEach(script => {
                        const dir = script.directory;
                        if (!groupedScripts[dir]) {
                            groupedScripts[dir] = [];
                        }
                        groupedScripts[dir].push(script);
                    });

                    // Render HTML
                    let html = '';

                    // Root scripts first
                    if (groupedScripts['/']) {
                        groupedScripts['/'].forEach(script => {
                            html += renderScriptItem(script);
                        });
                    }

                    // Then directories
                    Object.keys(groupedScripts).sort().forEach(dir => {
                        if (dir === '/') return;

                        html += \`
                            <div class="directory-group">
                                <div class="directory-header" onclick="toggleDirectory(this)">
                                    <span class="directory-icon">📁</span>
                                    <span class="directory-name">\${dir.split('/').pop() || dir}</span>
                                </div>
                                <div class="directory-content">
                        \`;

                        groupedScripts[dir].forEach(script => {
                            html += renderScriptItem(script);
                        });

                        html += '</div></div>';
                    });

                    scriptList.innerHTML = html;
                }

                function renderScriptItem(script) {
                    const statusClass = script.status === 'running' ? 'running' :
                                       script.status === 'success' ? 'success' :
                                       script.status === 'failed' ? 'failed' : '';

                    const icon = script.isRunning ? '⟳' : '📄';

                    return \`
                        <div class="script-item \${statusClass}"
                             ondblclick="openScript('\${script.path}')"
                             title="\${script.path}">
                            <span class="script-icon">\${icon}</span>
                            <span class="script-name">\${script.name}</span>
                            <div class="script-actions">
                                \${script.isRunning
                                    ? \`<button class="action-button" onclick="stopScript('\${script.path}', event)" title="Stop">⬜</button>\`
                                    : \`<button class="action-button" onclick="runScript('\${script.path}', event)" title="Run">▶</button>\`
                                }
                                <button class="action-button" onclick="openScript('\${script.path}', event)" title="Open">📝</button>
                            </div>
                        </div>
                    \`;
                }

                function toggleDirectory(element) {
                    const content = element.nextElementSibling;
                    const icon = element.querySelector('.directory-icon');
                    if (content.style.display === 'none') {
                        content.style.display = '';
                        icon.textContent = '📁';
                    } else {
                        content.style.display = 'none';
                        icon.textContent = '📂';
                    }
                }

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


                // Initial state
                updateClearButton();
                searchInput.focus();
            </script>
        </body>
        </html>`;
    }

    public refresh(): void {
        this.updateScriptList();
    }
}