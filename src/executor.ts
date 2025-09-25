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
}

export class Executor implements vscode.Disposable {
    private runningScripts: Map<string, RunningScript> = new Map();
    private terminals: Map<string, vscode.Terminal> = new Map();
    private statusBarItem: vscode.StatusBarItem;

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

        vscode.window.onDidCloseTerminal((terminal) => {
            for (const [scriptPath, runningScript] of this.runningScripts.entries()) {
                if (runningScript.terminal === terminal) {
                    this.runningScripts.delete(scriptPath);
                    this.terminals.delete(scriptPath);
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

            const command = parameters ? `"${scriptPath}" ${parameters}` : `"${scriptPath}"`;
            terminal.sendText(command);

            const runningScript: RunningScript = {
                terminal: terminal,
                status: ExecutionStatus.Running,
                scriptPath: scriptPath
            };

            this.runningScripts.set(scriptPath, runningScript);
            this.terminals.set(scriptPath, terminal);

            this.monitorScriptExecution(scriptPath);
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

    private monitorScriptExecution(scriptPath: string): void {
        // Store a reference to check later
        const runningScript = this.runningScripts.get(scriptPath);
        if (!runningScript) {
            return;
        }

        // Set a reasonable timeout for monitoring (5 minutes max)
        const maxMonitorTime = 5 * 60 * 1000;
        const checkInterval = 1000;
        let elapsedTime = 0;

        const intervalId = setInterval(() => {
            elapsedTime += checkInterval;

            // Check if the script is still in our tracking
            if (!this.runningScripts.has(scriptPath)) {
                clearInterval(intervalId);
                return;
            }

            // Check if terminal was closed
            if (!this.terminals.has(scriptPath)) {
                this.updateScriptStatus(scriptPath, ExecutionStatus.Success);
                this.runningScripts.delete(scriptPath);
                this.updateStatusBar();
                clearInterval(intervalId);
                return;
            }

            // Stop monitoring after max time
            if (elapsedTime >= maxMonitorTime) {
                clearInterval(intervalId);
            }
        }, checkInterval);
    }

    private updateScriptStatus(scriptPath: string, status: ExecutionStatus): void {
        const runningScript = this.runningScripts.get(scriptPath);
        if (runningScript) {
            runningScript.status = status;
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
        for (const terminal of this.terminals.values()) {
            terminal.dispose();
        }
        this.terminals.clear();
        this.runningScripts.clear();
        this.statusBarItem.dispose();
    }

    public getRunningScripts(): string[] {
        return Array.from(this.runningScripts.keys());
    }

    public isScriptRunning(scriptPath: string): boolean {
        return this.runningScripts.has(scriptPath);
    }
}
