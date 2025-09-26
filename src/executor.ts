import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess } from 'child_process';
import { SecurityChecker } from './security';
import { ConfigManager } from './config';

export enum ExecutionStatus {
    Idle = 'idle',
    Running = 'running',
    Success = 'success',
    Failed = 'failed'
}

interface RunningScript {
    terminal: vscode.Terminal;
    process?: ChildProcess;
    status: ExecutionStatus;
    scriptPath: string;
    startTime: number;
    intervalId?: NodeJS.Timeout;
}

export class Executor implements vscode.Disposable {
    private runningScripts: Map<string, RunningScript> = new Map();
    private terminals: Map<string, vscode.Terminal> = new Map();
    private statusBarItem: vscode.StatusBarItem;
    private onScriptStatusChanged: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
    public readonly onStatusChanged = this.onScriptStatusChanged.event;

    constructor(
        context: vscode.ExtensionContext,
        private securityChecker: SecurityChecker,
        private configManager: ConfigManager
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        context.subscriptions.push(this.statusBarItem);
        context.subscriptions.push(this.onScriptStatusChanged);

        // Listen for terminal close events (when user manually closes)
        vscode.window.onDidCloseTerminal((terminal) => {
            for (const [scriptPath, runningScript] of this.runningScripts.entries()) {
                if (runningScript.terminal === terminal) {
                    console.log(`RunMate: Terminal manually closed by user for script: ${scriptPath}`);
                    // User closed the terminal, clean up the tracking
                    this.handleScriptCompletion(scriptPath, ExecutionStatus.Success);
                    break; // Exit loop once we find the matching script
                }
            }
            this.updateStatusBar();
        });
    }

    /**
     * Check if a script contains parameter placeholders
     * @param scriptPath Path to the script file
     * @returns true if script uses parameters, false otherwise
     */
    public hasParameters(scriptPath: string): boolean {
        try {
            const scriptContent = fs.readFileSync(scriptPath, 'utf8');
            // Check for common parameter patterns in shell scripts
            // $1, $2, etc. for positional parameters
            // $@, $* for all parameters
            // ${1}, ${2}, etc. for explicit parameter expansion
            // Be careful not to match environment variables like $HOME, $PATH, etc.
            const parameterPatterns = [
                /\$[1-9][0-9]*/,        // $1, $2, etc.
                /\$[@*#]/,              // $@, $*, $#
                /\$\{[1-9][0-9]*\}/,    // ${1}, ${2}, etc.
                /\$\{[@*#]\}/           // ${@}, ${*}, ${#}
            ];

            const hasParams = parameterPatterns.some(pattern => pattern.test(scriptContent));
            console.log(`RunMate: Checked ${scriptPath} for parameters: ${hasParams}`);
            if (hasParams) {
                // Log which pattern matched for debugging
                for (const pattern of parameterPatterns) {
                    if (pattern.test(scriptContent)) {
                        const match = scriptContent.match(pattern);
                        console.log(`RunMate: Found parameter pattern: ${match?.[0]} matching ${pattern}`);
                        break;
                    }
                }
            }
            return hasParams;
        } catch (error) {
            console.error(`RunMate: Failed to check parameters for ${scriptPath}: ${error}`);
            // If we can't read the script, don't assume it needs parameters
            // This was causing issues when files couldn't be read
            console.log(`RunMate: Defaulting to no parameters for unreadable script`);
            return false;
        }
    }

    public async executeScript(scriptPath: string, parameters: string): Promise<void> {
        if (this.runningScripts.has(scriptPath)) {
            vscode.window.showWarningMessage(`Script ${path.basename(scriptPath)} is already running`);
            return;
        }

        try {
            await this.ensureExecutable(scriptPath);

            const scriptContent = fs.readFileSync(scriptPath, 'utf8');
            const dangerousCommand = await this.securityChecker.checkForDangerousCommands(scriptContent, parameters);

            if (dangerousCommand) {
                const confirmation = await vscode.window.showWarningMessage(
                    `⚠️ Dangerous command detected: "${dangerousCommand}"\nAre you sure you want to continue?`,
                    { modal: true },
                    'Continue',
                    'Cancel'
                );

                if (confirmation !== 'Continue') {
                    return;
                }
            }

            const scriptName = path.basename(scriptPath);
            const terminalName = `[${scriptName}]`;

            const workingDir = this.getWorkingDirectory(scriptPath);

            // Get configuration
            const config = vscode.workspace.getConfiguration('runmate');
            const keepOpen = config.get<boolean>('keepTerminalOpen', true);

            // Create terminal - VS Code will keep it open by default
            const terminal = vscode.window.createTerminal({
                name: terminalName,
                cwd: workingDir,
                env: process.env
            });

            terminal.show();

            // Execute script in terminal
            const command = parameters ? `"${scriptPath}" ${parameters}` : `"${scriptPath}"`;

            const runningScript: RunningScript = {
                terminal: terminal,
                status: ExecutionStatus.Running,
                scriptPath: scriptPath,
                startTime: Date.now()
            };

            if (keepOpen) {
                // Keep terminal open after script execution
                // Simply run the command and show exit code
                // We'll mark it as complete after a short delay
                terminal.sendText(`${command}; EXIT_CODE=$?; echo ""; echo "Exit code: $EXIT_CODE"`);
            } else {
                // Close terminal after script execution
                terminal.sendText(`${command}; exit $?`);
            }

            this.runningScripts.set(scriptPath, runningScript);
            this.terminals.set(scriptPath, terminal);

            // Monitor for script completion
            this.monitorScriptCompletion(scriptPath);

            this.updateStatusBar();

            vscode.window.showInformationMessage(`Executing: ${scriptName}`);

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to execute script: ${error}`);
            this.updateScriptStatus(scriptPath, ExecutionStatus.Failed);
        }
    }

    public async stopScript(scriptPath: string): Promise<void> {
        const runningScript = this.runningScripts.get(scriptPath);
        if (!runningScript) {
            vscode.window.showInformationMessage('Script is not running');
            return;
        }

        const scriptName = path.basename(scriptPath);

        const action = await vscode.window.showQuickPick(
            ['Terminate Gracefully (SIGINT)', 'Force Kill (SIGKILL)', 'Cancel'],
            {
                placeHolder: `How do you want to stop ${scriptName}?`
            }
        );

        if (action === 'Cancel' || !action) {
            return;
        }

        // Clean up monitoring interval
        if (runningScript.intervalId) {
            clearInterval(runningScript.intervalId);
        }

        if (runningScript.terminal) {
            runningScript.terminal.dispose();
        }

        if (runningScript.process) {
            if (action === 'Force Kill (SIGKILL)') {
                runningScript.process.kill('SIGKILL');
            } else {
                runningScript.process.kill('SIGINT');
            }
        }

        this.runningScripts.delete(scriptPath);
        this.terminals.delete(scriptPath);
        this.updateStatusBar();
        // Notify that the script has been stopped
        this.onScriptStatusChanged.fire(scriptPath);

        vscode.window.showInformationMessage(`Stopped: ${scriptName}`);
    }

    private async ensureExecutable(scriptPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            fs.access(scriptPath, fs.constants.X_OK, (err) => {
                if (err) {
                    fs.chmod(scriptPath, '755', (chmodErr) => {
                        if (chmodErr) {
                            reject(`Failed to make script executable: ${chmodErr}`);
                        } else {
                            vscode.window.showInformationMessage(`Made script executable: ${path.basename(scriptPath)}`);
                            resolve();
                        }
                    });
                } else {
                    resolve();
                }
            });
        });
    }

    private getWorkingDirectory(scriptPath: string): string {
        const defaultWorkingDir = this.configManager.getDefaultWorkingDirectory();

        if (defaultWorkingDir && defaultWorkingDir !== './') {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
                return path.resolve(workspaceFolder.uri.fsPath, defaultWorkingDir);
            }
        }

        return path.dirname(scriptPath);
    }

    private handleScriptCompletion(scriptPath: string, status: ExecutionStatus): void {
        const runningScript = this.runningScripts.get(scriptPath);
        if (runningScript) {
            console.log(`RunMate: Script completed: ${scriptPath} with status: ${status}`);

            // Clean up monitoring interval
            if (runningScript.intervalId) {
                clearInterval(runningScript.intervalId);
            }

            // Immediately remove from running scripts to update status bar
            this.runningScripts.delete(scriptPath);
            this.terminals.delete(scriptPath);

            // Update status bar to show script is no longer running
            this.updateStatusBar();

            // Fire event to refresh UI
            this.onScriptStatusChanged.fire(scriptPath);

            console.log(`RunMate: Script ${scriptPath} removed from running list, status bar updated`);
        }
    }

    private monitorScriptCompletion(scriptPath: string): void {
        const runningScript = this.runningScripts.get(scriptPath);
        if (!runningScript) {
            return;
        }

        const config = vscode.workspace.getConfiguration('runmate');
        const keepOpen = config.get<boolean>('keepTerminalOpen', true);

        if (!keepOpen) {
            // If terminal closes automatically, we'll detect it via onDidCloseTerminal
            return;
        }

        // For terminals that stay open, we need to estimate completion time
        // Most scripts complete within seconds
        const estimatedCompleteTime = 2 * 1000; // 2 seconds for most scripts
        const maxMonitorTime = 30 * 60 * 1000; // Monitor for max 30 minutes

        // Mark as complete after estimated time
        const completionTimer = setTimeout(() => {
            if (this.runningScripts.has(scriptPath)) {
                console.log(`RunMate: Marking script as completed: ${scriptPath}`);
                this.handleScriptCompletion(scriptPath, ExecutionStatus.Success);
            }
        }, estimatedCompleteTime);

        // Store timeout for cleanup
        runningScript.intervalId = completionTimer as unknown as NodeJS.Timeout;

        // Still monitor if user manually closes the terminal
        const checkInterval = setInterval(() => {
            // Check if terminal still exists (user manually closed it)
            const terminalExists = vscode.window.terminals.includes(runningScript.terminal);
            if (!terminalExists) {
                console.log(`RunMate: Terminal manually closed by user for script: ${scriptPath}`);
                clearTimeout(completionTimer);
                clearInterval(checkInterval);
                if (this.runningScripts.has(scriptPath)) {
                    this.handleScriptCompletion(scriptPath, ExecutionStatus.Success);
                }
                return;
            }

            // Check if script is still being tracked
            if (!this.runningScripts.has(scriptPath)) {
                clearInterval(checkInterval);
                clearTimeout(completionTimer);
                return;
            }
        }, 500); // Check every 500ms for faster response

        // Clean up interval after max time
        setTimeout(() => {
            clearInterval(checkInterval);
        }, maxMonitorTime);
    }


    private updateScriptStatus(scriptPath: string, status: ExecutionStatus): void {
        const runningScript = this.runningScripts.get(scriptPath);
        if (runningScript) {
            console.log(`RunMate: Updating script status: ${scriptPath} to ${status}`);
            runningScript.status = status;
            // Fire event when status changes
            this.onScriptStatusChanged.fire(scriptPath);
        }
    }

    public getScriptStatus(scriptPath: string): ExecutionStatus {
        const runningScript = this.runningScripts.get(scriptPath);
        return runningScript ? runningScript.status : ExecutionStatus.Idle;
    }

    private updateStatusBar(): void {
        const runningCount = this.runningScripts.size;
        console.log(`RunMate: Updating status bar, running scripts count: ${runningCount}`);

        if (runningCount > 0) {
            this.statusBarItem.text = `$(sync~spin) ${runningCount} script${runningCount > 1 ? 's' : ''} running`;
            this.statusBarItem.tooltip = 'Scripts are currently running';
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    public dispose(): void {
        // Clean up all monitoring intervals
        for (const runningScript of this.runningScripts.values()) {
            if (runningScript.intervalId) {
                clearInterval(runningScript.intervalId);
            }
        }

        for (const terminal of this.terminals.values()) {
            terminal.dispose();
        }
        this.terminals.clear();
        this.runningScripts.clear();
        this.statusBarItem.dispose();
        this.onScriptStatusChanged.dispose();
    }

    public getRunningScripts(): string[] {
        return Array.from(this.runningScripts.keys());
    }

    public isScriptRunning(scriptPath: string): boolean {
        return this.runningScripts.has(scriptPath);
    }

}
