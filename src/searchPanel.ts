import * as vscode from 'vscode';

export class SearchPanel {
    private panel: vscode.WebviewPanel | undefined;
    private onSearchChange: (query: string) => void;

    constructor(
        private context: vscode.ExtensionContext,
        onSearchChange: (query: string) => void
    ) {
        this.onSearchChange = onSearchChange;
    }

    public show(currentQuery: string = ''): void {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        // Create webview panel
        this.panel = vscode.window.createWebviewPanel(
            'runmateSearch',
            'Search Scripts',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getHtmlContent(currentQuery);

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'search':
                        this.onSearchChange(message.text);
                        break;
                    case 'clear':
                        this.onSearchChange('');
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );

        // Clean up when panel is closed
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    private getHtmlContent(currentQuery: string): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    padding: 10px;
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .search-container {
                    display: flex;
                    align-items: center;
                    background-color: var(--vscode-input-background);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    padding: 4px;
                }
                .search-container:focus-within {
                    border-color: var(--vscode-focusBorder);
                    outline: 1px solid var(--vscode-focusBorder);
                }
                .search-input {
                    flex: 1;
                    background: transparent;
                    border: none;
                    color: var(--vscode-input-foreground);
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    outline: none;
                    padding: 4px 6px;
                }
                .search-input::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                }
                .clear-button {
                    background: transparent;
                    border: none;
                    color: var(--vscode-icon-foreground);
                    cursor: pointer;
                    padding: 4px 8px;
                    font-size: 14px;
                    display: none;
                }
                .clear-button:hover {
                    color: var(--vscode-foreground);
                }
                .clear-button.visible {
                    display: block;
                }
                .search-icon {
                    color: var(--vscode-icon-foreground);
                    padding: 0 6px;
                }
            </style>
        </head>
        <body>
            <div class="search-container">
                <span class="search-icon">🔍</span>
                <input
                    type="text"
                    class="search-input"
                    placeholder="Search scripts..."
                    value="${currentQuery}"
                    id="searchInput"
                />
                <button class="clear-button" id="clearButton" title="Clear search">✕</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const searchInput = document.getElementById('searchInput');
                const clearButton = document.getElementById('clearButton');

                // Update clear button visibility
                function updateClearButton() {
                    if (searchInput.value) {
                        clearButton.classList.add('visible');
                    } else {
                        clearButton.classList.remove('visible');
                    }
                }

                // Initial state
                updateClearButton();

                // Handle input changes
                let timeout;
                searchInput.addEventListener('input', (e) => {
                    clearTimeout(timeout);
                    updateClearButton();
                    // Debounce search
                    timeout = setTimeout(() => {
                        vscode.postMessage({
                            command: 'search',
                            text: e.target.value
                        });
                    }, 200);
                });

                // Handle clear button
                clearButton.addEventListener('click', () => {
                    searchInput.value = '';
                    updateClearButton();
                    vscode.postMessage({
                        command: 'clear'
                    });
                });

                // Focus input on load
                searchInput.focus();
            </script>
        </body>
        </html>`;
    }

    public dispose(): void {
        if (this.panel) {
            this.panel.dispose();
        }
    }
}