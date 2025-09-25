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

        // Listen for terminal close events
        vscode.window.onDidCloseTerminal((terminal) => {
            for (const [scriptPath, runningScript] of this.runningScripts.entries()) {
                if (runningScript.terminal === terminal) {
                    console.log(`RunMate: Terminal closed for script: ${scriptPath}`);
                    // Terminal closed means script completed
                    this.handleScriptCompletion(scriptPath, ExecutionStatus.Success);
                    break; // Exit loop once we find the matching script
                }
            }
            this.updateStatusBar();
        });
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

            const terminal = vscode.window.createTerminal({
                name: terminalName,
                cwd: workingDir,
                env: process.env
            });

            terminal.show();

            // Execute script in terminal
            const command = parameters ? `"${scriptPath}" ${parameters}` : `"${scriptPath}"`;

            // Send command with exit code display
            terminal.sendText(`${command}; EXIT_CODE=$?; echo ""; echo "Exit code: $EXIT_CODE"; exit $EXIT_CODE`);

            const runningScript: RunningScript = {
                terminal: terminal,
                status: ExecutionStatus.Running,
                scriptPath: scriptPath,
                startTime: Date.now()
            };

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

            // Update status temporarily to show completion
            this.updateScriptStatus(scriptPath, status);
            this.updateStatusBar();
            this.onScriptStatusChanged.fire(scriptPath);

            // After 3 seconds, clean up the script completely (back to idle state)
            setTimeout(() => {
                if (this.runningScripts.has(scriptPath)) {
                    console.log(`RunMate: Cleaning up completed script: ${scriptPath}`);
                    this.runningScripts.delete(scriptPath);
                    this.terminals.delete(scriptPath);
                    // Fire event again to refresh UI to idle state
                    this.onScriptStatusChanged.fire(scriptPath);
                }
            }, 3000);
        }
    }

    private monitorScriptCompletion(scriptPath: string): void {
        const runningScript = this.runningScripts.get(scriptPath);
        if (!runningScript) {
            return;
        }

        // Use VS Code's Terminal API to detect when the command completes
        // For now, we'll use a simpler approach with terminal closure detection
        const checkInterval = 1000;
        const maxMonitorTime = 30 * 60 * 1000; // Monitor for max 30 minutes
        let elapsedTime = 0;

        const intervalId = setInterval(() => {
            elapsedTime += checkInterval;

            // Check if script is still being tracked
            if (!this.runningScripts.has(scriptPath)) {
                clearInterval(intervalId);
                return;
            }

            // Check if terminal still exists (user closed it)
            const terminalExists = vscode.window.terminals.includes(runningScript.terminal);
            if (!terminalExists) {
                console.log(`RunMate: Terminal closed for script: ${scriptPath}`);
                this.handleScriptCompletion(scriptPath, ExecutionStatus.Success);
                clearInterval(intervalId);
                return;
            }

            // Stop monitoring after max time
            if (elapsedTime >= maxMonitorTime) {
                console.log(`RunMate: Max monitor time reached for script: ${scriptPath}`);
                this.handleScriptCompletion(scriptPath, ExecutionStatus.Success);
                clearInterval(intervalId);
            }
        }, checkInterval);

        // Store interval ID for cleanup
        runningScript.intervalId = intervalId;

        // Use a shorter check for terminal shell integration (command completion)
        // Since we added 'exit $EXIT_CODE' to the command, the terminal will close when script completes
        const quickCheckInterval = setInterval(() => {
            // Check if terminal still exists
            const terminalExists = vscode.window.terminals.includes(runningScript.terminal);
            if (!terminalExists) {
                console.log(`RunMate: Script completed (terminal closed) for: ${scriptPath}`);
                clearInterval(quickCheckInterval);
                clearInterval(intervalId);

                if (this.runningScripts.has(scriptPath)) {
                    // Assume success since we can't get the actual exit code
                    this.handleScriptCompletion(scriptPath, ExecutionStatus.Success);
                }
            }
        }, 200); // Check every 200ms for faster response

        // Clean up quick check after max time
        setTimeout(() => clearInterval(quickCheckInterval), maxMonitorTime);
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
