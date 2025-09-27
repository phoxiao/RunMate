import * as vscode from 'vscode';
import * as path from 'path';

export enum TerminalStatus {
    Running = 'running',
    Completed = 'completed',
    Failed = 'failed'
}

export interface ManagedTerminal {
    terminal: vscode.Terminal;
    scriptPath: string;
    scriptName: string;
    status: TerminalStatus;
    startTime: number;
    endTime?: number;
    originalName?: string;  // Store original terminal name for restoration
}

export class TerminalManager implements vscode.Disposable {
    private terminals: Map<string, ManagedTerminal> = new Map();
    private terminalsByScript: Map<string, string[]> = new Map();
    private statusBarItem: vscode.StatusBarItem;
    private onTerminalsChanged: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeTerminals = this.onTerminalsChanged.event;
    private maxTerminalHistory: number = 10;

    constructor(context: vscode.ExtensionContext) {
        // Create status bar item for terminal count
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            99
        );
        this.statusBarItem.command = 'runmate.showTerminalManager';
        context.subscriptions.push(this.statusBarItem);
        context.subscriptions.push(this.onTerminalsChanged);

        // Listen for terminal close events
        vscode.window.onDidCloseTerminal((terminal) => {
            this.handleTerminalClosed(terminal);
        });

        // Update configuration
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('runmate.maxTerminalHistory')) {
                const config = vscode.workspace.getConfiguration('runmate');
                this.maxTerminalHistory = config.get<number>('maxTerminalHistory', 10);
                this.checkTerminalLimit();
            }
        });

        // Load initial configuration
        const config = vscode.workspace.getConfiguration('runmate');
        this.maxTerminalHistory = config.get<number>('maxTerminalHistory', 10);

        this.updateStatusBar();
    }

    /**
     * Get or create a terminal for script execution
     */
    public getOrCreateTerminal(
        scriptPath: string,
        workingDir: string,
        reuseMode: 'always' | 'never' | 'smart'
    ): vscode.Terminal {
        const scriptName = path.basename(scriptPath);

        // Check for existing terminal based on reuse mode
        if (reuseMode !== 'never') {
            const existingTerminalId = this.findReusableTerminal(reuseMode);
            if (existingTerminalId) {
                const managed = this.terminals.get(existingTerminalId);
                if (managed) {
                    // Update terminal for new script
                    managed.scriptPath = scriptPath;
                    managed.scriptName = scriptName;
                    managed.status = TerminalStatus.Running;
                    managed.startTime = Date.now();
                    delete managed.endTime;

                    // Update terminal name to reflect current script
                    const timestamp = new Date().toLocaleTimeString('en-US', {
                        hour12: false,
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                    });
                    const newName = `[${scriptName}] ${timestamp}`;

                    // Try to rename terminal (VS Code doesn't support this directly, but we track it)
                    // We'll show the script name in the terminal output instead
                    console.log(`RunMate: Reusing terminal for ${scriptName} (was: ${managed.originalName || 'unknown'})`);
                    managed.originalName = newName;

                    // Update tracking
                    this.updateScriptTerminalMapping(scriptPath, existingTerminalId);
                    this.updateStatusBar();
                    this.onTerminalsChanged.fire();
                    return managed.terminal;
                }
            }
        }

        // Create new terminal
        const timestamp = new Date().toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        const terminalName = `[${scriptName}] ${timestamp}`;

        const terminal = vscode.window.createTerminal({
            name: terminalName,
            cwd: workingDir,
            env: process.env
        });

        // Create managed terminal entry
        const terminalId = this.generateTerminalId();
        const managed: ManagedTerminal = {
            terminal,
            scriptPath,
            scriptName,
            status: TerminalStatus.Running,
            startTime: Date.now(),
            originalName: terminalName
        };

        this.terminals.set(terminalId, managed);

        // Track by script path
        const scriptTerminals = this.terminalsByScript.get(scriptPath) || [];
        scriptTerminals.push(terminalId);
        this.terminalsByScript.set(scriptPath, scriptTerminals);

        // Check if we exceeded the limit
        this.checkTerminalLimit();

        this.updateStatusBar();
        this.onTerminalsChanged.fire();

        return terminal;
    }

    /**
     * Mark a terminal as completed
     */
    public markCompleted(scriptPath: string, success: boolean): void {
        const terminalIds = this.terminalsByScript.get(scriptPath) || [];
        for (const id of terminalIds) {
            const managed = this.terminals.get(id);
            if (managed && managed.status === TerminalStatus.Running) {
                managed.status = success ? TerminalStatus.Completed : TerminalStatus.Failed;
                managed.endTime = Date.now();
                this.updateTerminalName(managed);
                break;
            }
        }
        this.updateStatusBar();
        this.onTerminalsChanged.fire();
    }

    /**
     * Close all terminals
     */
    public closeAllTerminals(): void {
        let count = 0;
        for (const managed of this.terminals.values()) {
            managed.terminal.dispose();
            count++;
        }
        this.terminals.clear();
        this.terminalsByScript.clear();
        this.updateStatusBar();
        this.onTerminalsChanged.fire();

        if (count > 0) {
            vscode.window.showInformationMessage(`Closed ${count} terminal${count > 1 ? 's' : ''}`);
        }
    }

    /**
     * Close completed terminals only
     */
    public closeCompletedTerminals(): void {
        let count = 0;
        const toRemove: string[] = [];

        for (const [id, managed] of this.terminals) {
            if (managed.status === TerminalStatus.Completed || managed.status === TerminalStatus.Failed) {
                managed.terminal.dispose();
                toRemove.push(id);
                count++;
            }
        }

        // Remove from tracking
        for (const id of toRemove) {
            const managed = this.terminals.get(id);
            if (managed) {
                this.removeTerminalTracking(id, managed.scriptPath);
            }
        }

        this.updateStatusBar();
        this.onTerminalsChanged.fire();

        if (count > 0) {
            vscode.window.showInformationMessage(`Closed ${count} completed terminal${count > 1 ? 's' : ''}`);
        } else {
            vscode.window.showInformationMessage('No completed terminals to close');
        }
    }

    /**
     * Close a specific script's terminal
     */
    public closeScriptTerminal(scriptPath: string): void {
        const terminalIds = this.terminalsByScript.get(scriptPath) || [];
        for (const id of terminalIds) {
            const managed = this.terminals.get(id);
            if (managed) {
                managed.terminal.dispose();
                this.removeTerminalTracking(id, scriptPath);
            }
        }
        this.updateStatusBar();
        this.onTerminalsChanged.fire();
    }

    /**
     * Get all managed terminals
     */
    public getAllTerminals(): ManagedTerminal[] {
        return Array.from(this.terminals.values());
    }

    /**
     * Get terminal count by status
     */
    public getTerminalCounts(): { total: number; running: number; completed: number; failed: number } {
        let running = 0;
        let completed = 0;
        let failed = 0;

        for (const managed of this.terminals.values()) {
            switch (managed.status) {
                case TerminalStatus.Running:
                    running++;
                    break;
                case TerminalStatus.Completed:
                    completed++;
                    break;
                case TerminalStatus.Failed:
                    failed++;
                    break;
            }
        }

        return { total: this.terminals.size, running, completed, failed };
    }

    /**
     * Focus a specific terminal
     */
    public focusTerminal(terminalId: string): void {
        const managed = this.terminals.get(terminalId);
        if (managed) {
            managed.terminal.show();
        }
    }

    private findReusableTerminal(reuseMode: 'always' | 'smart'): string | undefined {
        // Look for any reusable terminal across all scripts
        for (const [terminalId, managed] of this.terminals) {
            // Check if terminal is still alive
            const terminalStillExists = vscode.window.terminals.includes(managed.terminal);
            if (!terminalStillExists) {
                // Terminal was closed, clean up and continue
                this.removeTerminalTracking(terminalId, managed.scriptPath);
                continue;
            }

            if (reuseMode === 'always') {
                // In 'always' mode, reuse any available terminal
                console.log(`RunMate: Reusing terminal globally (always mode)`);
                return terminalId;
            } else if (reuseMode === 'smart') {
                // In 'smart' mode, only reuse if the terminal is not currently running
                if (managed.status !== TerminalStatus.Running) {
                    console.log(`RunMate: Reusing terminal globally (smart mode, status: ${managed.status})`);
                    return terminalId;
                }
            }
        }

        return undefined;
    }

    private updateScriptTerminalMapping(scriptPath: string, terminalId: string): void {
        // Remove this terminal from other script mappings
        for (const [path, ids] of this.terminalsByScript) {
            if (path !== scriptPath) {
                const index = ids.indexOf(terminalId);
                if (index > -1) {
                    ids.splice(index, 1);
                    if (ids.length === 0) {
                        this.terminalsByScript.delete(path);
                    }
                }
            }
        }

        // Add to current script mapping
        const scriptTerminals = this.terminalsByScript.get(scriptPath) || [];
        if (!scriptTerminals.includes(terminalId)) {
            scriptTerminals.push(terminalId);
            this.terminalsByScript.set(scriptPath, scriptTerminals);
        }
    }

    private updateTerminalName(_managed: ManagedTerminal): void {
        // Note: VS Code doesn't allow changing terminal name after creation
        // This is a limitation of the VS Code API
        // We'll track the status internally and show it in the UI
    }

    private handleTerminalClosed(terminal: vscode.Terminal): void {
        for (const [id, managed] of this.terminals) {
            if (managed.terminal === terminal) {
                this.removeTerminalTracking(id, managed.scriptPath);
                break;
            }
        }
        this.updateStatusBar();
        this.onTerminalsChanged.fire();
    }

    private removeTerminalTracking(terminalId: string, scriptPath: string): void {
        this.terminals.delete(terminalId);

        const scriptTerminals = this.terminalsByScript.get(scriptPath);
        if (scriptTerminals) {
            const index = scriptTerminals.indexOf(terminalId);
            if (index > -1) {
                scriptTerminals.splice(index, 1);
            }
            if (scriptTerminals.length === 0) {
                this.terminalsByScript.delete(scriptPath);
            }
        }
    }

    private checkTerminalLimit(): void {
        if (this.terminals.size > this.maxTerminalHistory) {
            const excess = this.terminals.size - this.maxTerminalHistory;
            vscode.window.showWarningMessage(
                `Terminal limit exceeded (${this.terminals.size}/${this.maxTerminalHistory}). Consider closing ${excess} terminal${excess > 1 ? 's' : ''}.`,
                'Close Completed',
                'Close All',
                'Ignore'
            ).then(selection => {
                if (selection === 'Close Completed') {
                    this.closeCompletedTerminals();
                } else if (selection === 'Close All') {
                    this.closeAllTerminals();
                }
            });
        }
    }

    private updateStatusBar(): void {
        const counts = this.getTerminalCounts();

        if (counts.total === 0) {
            this.statusBarItem.hide();
        } else {
            let text = `$(terminal) ${counts.total}`;
            let tooltip = `RunMate Terminals\nTotal: ${counts.total}`;

            if (counts.running > 0) {
                text += ` (${counts.running} running)`;
                tooltip += `\nRunning: ${counts.running}`;
            }

            if (counts.completed > 0) {
                tooltip += `\nCompleted: ${counts.completed}`;
            }

            if (counts.failed > 0) {
                tooltip += `\nFailed: ${counts.failed}`;
            }

            tooltip += '\nClick to manage terminals';

            this.statusBarItem.text = text;
            this.statusBarItem.tooltip = tooltip;
            this.statusBarItem.show();
        }
    }


    private generateTerminalId(): string {
        return `terminal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    public dispose(): void {
        for (const managed of this.terminals.values()) {
            managed.terminal.dispose();
        }
        this.terminals.clear();
        this.terminalsByScript.clear();
        this.statusBarItem.dispose();
        this.onTerminalsChanged.dispose();
    }
}