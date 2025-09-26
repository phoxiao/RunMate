import * as vscode from 'vscode';

export class SearchWidget {
    private statusBarItem: vscode.StatusBarItem;
    private isSearchActive: boolean = false;
    private searchQuery: string = '';
    private onSearchChange: (query: string) => void;
    private quickInput: vscode.QuickInput | undefined;

    constructor(
        context: vscode.ExtensionContext,
        onSearchChange: (query: string) => void
    ) {
        this.onSearchChange = onSearchChange;

        // Create a status bar item that acts as a search trigger
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'runmate.toggleSearch';
        this.statusBarItem.text = '$(search) Search Scripts';
        this.statusBarItem.tooltip = 'Click to search scripts (Cmd+Shift+F)';
        context.subscriptions.push(this.statusBarItem);

        // Register toggle search command
        const toggleSearchCommand = vscode.commands.registerCommand('runmate.toggleSearch', () => {
            this.toggleSearch();
        });
        context.subscriptions.push(toggleSearchCommand);
    }

    public toggleSearch(): void {
        if (this.isSearchActive && this.quickInput) {
            this.quickInput.hide();
            this.isSearchActive = false;
        } else {
            this.showSearchInput();
        }
    }

    private showSearchInput(): void {
        const input = vscode.window.createInputBox();
        input.placeholder = 'Type to search scripts (fuzzy matching)';
        input.value = this.searchQuery;
        input.title = 'Search Scripts';

        // Show buttons
        input.buttons = [
            {
                iconPath: new vscode.ThemeIcon('close'),
                tooltip: 'Clear search'
            }
        ];

        // Handle input changes
        input.onDidChangeValue(value => {
            this.searchQuery = value;
            this.onSearchChange(value);
            this.updateStatusBar();
        });

        // Handle button clicks
        input.onDidTriggerButton(() => {
            input.value = '';
            this.searchQuery = '';
            this.onSearchChange('');
            this.updateStatusBar();
        });

        // Handle accept
        input.onDidAccept(() => {
            // Keep the search active
            this.isSearchActive = true;
        });

        // Handle hide
        input.onDidHide(() => {
            this.isSearchActive = false;
            this.quickInput = undefined;
            input.dispose();
        });

        this.quickInput = input;
        this.isSearchActive = true;
        input.show();

        this.updateStatusBar();
    }

    private updateStatusBar(): void {
        if (this.searchQuery) {
            this.statusBarItem.text = `$(search) Filtering: "${this.searchQuery}"`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.statusBarItem.text = '$(search) Search Scripts';
            this.statusBarItem.backgroundColor = undefined;
        }
    }

    public show(): void {
        this.statusBarItem.show();
    }

    public hide(): void {
        this.statusBarItem.hide();
    }

    public clearSearch(): void {
        this.searchQuery = '';
        this.onSearchChange('');
        this.updateStatusBar();
        if (this.quickInput) {
            this.quickInput.hide();
        }
    }

    public getSearchQuery(): string {
        return this.searchQuery;
    }

    public dispose(): void {
        if (this.quickInput) {
            this.quickInput.hide();
        }
        this.statusBarItem.dispose();
    }
}