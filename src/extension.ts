import * as vscode from 'vscode';
import { CombinedWebviewProvider } from './combinedWebviewProvider';
import { ScriptScanner } from './scriptScanner';
import { LogScanner } from './logScanner';
import { Executor } from './executor';
import { ConfigManager } from './config';
import { SecurityChecker } from './security';

let combinedWebviewProvider: CombinedWebviewProvider;
let scriptScanner: ScriptScanner;
let logScanner: LogScanner;
let executor: Executor;
let configManager: ConfigManager;

export async function activate(context: vscode.ExtensionContext) {
    console.log('RunMate extension is now active');

    try {
        // Initialize all services first
        configManager = new ConfigManager();
        const securityChecker = new SecurityChecker(configManager);
        executor = new Executor(context, securityChecker, configManager);
        scriptScanner = new ScriptScanner(configManager);
        logScanner = new LogScanner(configManager);

        // Register ALL commands FIRST, before creating tree view
        // This ensures commands exist when the tree view tries to use them

        const refreshCommand = vscode.commands.registerCommand('runmate.refreshScripts', async () => {
            console.log('RunMate: Manual refresh triggered');
            await scriptScanner.scanScripts();
            if (combinedWebviewProvider) {
                combinedWebviewProvider.refresh();
            }
        });
        context.subscriptions.push(refreshCommand);
        console.log('RunMate: Refresh command registered');

        const runScriptCommand = vscode.commands.registerCommand('runmate.runScript', async (scriptItem) => {
            if (!scriptItem) {
                vscode.window.showErrorMessage('No script selected');
                return;
            }

            const config = vscode.workspace.getConfiguration('runmate');
            const scriptName = scriptItem.label;
            const scriptPath = scriptItem.filePath;
            let parameters = '';

            // Check if script has parameters
            const hasParams = executor.hasParameters(scriptItem.filePath);
            console.log(`RunMate: Script ${scriptItem.label} hasParams: ${hasParams}`);

            // Get last parameters if remember is enabled and script has parameters
            if (hasParams && config.get<boolean>('rememberLastParameters')) {
                const lastParams = context.workspaceState.get<string>(`params_${scriptItem.filePath}`);
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
                        await context.workspaceState.update(`params_${scriptItem.filePath}`, parameters);
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

            await executor.executeScript(scriptItem.filePath, parameters || '');
            // Refresh will be triggered by executor's onStatusChanged event
        });
        context.subscriptions.push(runScriptCommand);
        console.log('RunMate: Run script command registered');

        const stopScriptCommand = vscode.commands.registerCommand('runmate.stopScript', async (scriptItem) => {
            if (!scriptItem) {
                vscode.window.showErrorMessage('No script selected');
                return;
            }

            await executor.stopScript(scriptItem.filePath);
            // Refresh will be triggered by executor's onStatusChanged event
        });
        context.subscriptions.push(stopScriptCommand);
        console.log('RunMate: Stop script command registered');

        const openScriptCommand = vscode.commands.registerCommand('runmate.openScript', (scriptItem) => {
            if (scriptItem) {
                vscode.workspace.openTextDocument(scriptItem.filePath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
            }
        });
        context.subscriptions.push(openScriptCommand);
        console.log('RunMate: Open script command registered');


        const deleteScriptCommand = vscode.commands.registerCommand('runmate.deleteScript', async (scriptItem) => {
            if (!scriptItem || !scriptItem.filePath) {
                vscode.window.showErrorMessage('No script selected');
                return;
            }

            const scriptName = scriptItem.label;
            const scriptPath = scriptItem.filePath;

            // Show confirmation dialog
            const confirmation = await vscode.window.showWarningMessage(
                `Are you sure you want to delete "${scriptName}"?\n\nThis action cannot be undone.`,
                { modal: true },
                'Delete',
                'Cancel'
            );

            if (confirmation !== 'Delete') {
                return;
            }

            try {
                // Delete the file using VS Code's file system API
                const fileUri = vscode.Uri.file(scriptPath);
                await vscode.workspace.fs.delete(fileUri);

                // Show success message
                vscode.window.showInformationMessage(`Successfully deleted: ${scriptName}`);

                // Refresh the script list
                await scriptScanner.scanScripts();
                if (combinedWebviewProvider) {
                    combinedWebviewProvider.refresh();
                }

                console.log(`RunMate: Deleted script: ${scriptPath}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete script: ${error}`);
                console.error(`RunMate: Failed to delete script: ${scriptPath}`, error);
            }
        });
        context.subscriptions.push(deleteScriptCommand);
        console.log('RunMate: Delete script command registered');

        const openConfigCommand = vscode.commands.registerCommand('runmate.openConfig', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }

            const configPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'run-mate.json');

            try {
                await vscode.workspace.fs.stat(configPath);
            } catch {
                const defaultConfig = {
                    ignoreDirectories: ['node_modules', '.git'],
                    defaultWorkingDirectory: './',
                    customSort: [],
                    dangerousCommandsWhitelist: [],
                    dangerousCommandsBlacklist: ['rm -rf /', 'mkfs', ':(){:|:&};:']
                };

                await vscode.workspace.fs.writeFile(
                    configPath,
                    Buffer.from(JSON.stringify(defaultConfig, null, 2))
                );
            }

            const doc = await vscode.workspace.openTextDocument(configPath);
            await vscode.window.showTextDocument(doc);
        });
        context.subscriptions.push(openConfigCommand);
        console.log('RunMate: Open config command registered');

        // Register terminal management commands
        const closeAllTerminalsCommand = vscode.commands.registerCommand('runmate.closeAllTerminals', () => {
            if (executor) {
                executor.getTerminalManager().closeAllTerminals();
                if (combinedWebviewProvider) {
                    combinedWebviewProvider.refresh();
                }
            }
        });
        context.subscriptions.push(closeAllTerminalsCommand);
        console.log('RunMate: Close all terminals command registered');

        const closeCompletedTerminalsCommand = vscode.commands.registerCommand('runmate.closeCompletedTerminals', () => {
            if (executor) {
                executor.getTerminalManager().closeCompletedTerminals();
                if (combinedWebviewProvider) {
                    combinedWebviewProvider.refresh();
                }
            }
        });
        context.subscriptions.push(closeCompletedTerminalsCommand);
        console.log('RunMate: Close completed terminals command registered');

        const showTerminalManagerCommand = vscode.commands.registerCommand('runmate.showTerminalManager', async () => {
            if (executor) {
                const terminalManager = executor.getTerminalManager();
                const terminals = terminalManager.getAllTerminals();
                const counts = terminalManager.getTerminalCounts();

                if (terminals.length === 0) {
                    vscode.window.showInformationMessage('No RunMate terminals are currently open');
                    return;
                }

                // Create quick pick items for each terminal
                const items = terminals.map(t => {
                    const statusIcon = t.status === 'running' ? '▶' :
                                       t.status === 'completed' ? '✓' : '✗';
                    const duration = t.endTime
                        ? `(${Math.round((t.endTime - t.startTime) / 1000)}s)`
                        : '(running)';

                    return {
                        label: `${statusIcon} ${t.scriptName}`,
                        description: duration,
                        detail: `Status: ${t.status}`,
                        terminal: t
                    };
                });

                // Add management options at the top
                const managementOptions = [
                    {
                        label: '$(close-all) Close All Terminals',
                        description: `${counts.total} terminal${counts.total > 1 ? 's' : ''}`,
                        action: 'closeAll'
                    },
                    {
                        label: '$(check) Close Completed Terminals',
                        description: `${counts.completed + counts.failed} terminal${(counts.completed + counts.failed) > 1 ? 's' : ''}`,
                        action: 'closeCompleted'
                    }
                ];

                const selection = await vscode.window.showQuickPick(
                    [...managementOptions, ...items],
                    {
                        placeHolder: `RunMate Terminals: ${counts.running} running, ${counts.completed} completed, ${counts.failed} failed`,
                        canPickMany: false
                    }
                );

                if (selection) {
                    if ('action' in selection) {
                        if (selection.action === 'closeAll') {
                            terminalManager.closeAllTerminals();
                        } else if (selection.action === 'closeCompleted') {
                            terminalManager.closeCompletedTerminals();
                        }
                    } else if ('terminal' in selection) {
                        // Focus the selected terminal
                        selection.terminal.terminal.show();
                    }
                }

                if (combinedWebviewProvider) {
                    combinedWebviewProvider.refresh();
                }
            }
        });
        context.subscriptions.push(showTerminalManagerCommand);
        console.log('RunMate: Show terminal manager command registered');

        // Register log commands
        const refreshLogsCommand = vscode.commands.registerCommand('runmate.refreshLogs', async () => {
            console.log('RunMate: Manual log refresh triggered');
            await logScanner.scanLogs();
            if (combinedWebviewProvider) {
                combinedWebviewProvider.refresh();
            }
        });
        context.subscriptions.push(refreshLogsCommand);
        console.log('RunMate: Refresh logs command registered');

        console.log('RunMate: All commands registered successfully');

        // Create and register the Combined WebviewViewProvider
        combinedWebviewProvider = new CombinedWebviewProvider(
            context.extensionUri,
            scriptScanner,
            logScanner,
            executor,
            context
        );

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                CombinedWebviewProvider.viewType,
                combinedWebviewProvider,
                {
                    webviewOptions: {
                        retainContextWhenHidden: true
                    }
                }
            )
        );
        console.log('RunMate: Webview provider registered successfully');

        // Perform initial scans
        await scriptScanner.scanScripts();
        await logScanner.scanLogs();
        console.log('RunMate: Initial scans completed');

        // Setup auto-refresh if enabled
        const config = vscode.workspace.getConfiguration('runmate');
        if (config.get<boolean>('autoRefresh')) {
            scriptScanner.startWatching(() => {
                if (combinedWebviewProvider) {
                    combinedWebviewProvider.refresh();
                }
            });
        }

        context.subscriptions.push(scriptScanner);
        context.subscriptions.push(logScanner);

        // Setup log file watching if auto-refresh enabled
        if (config.get<boolean>('autoRefresh')) {
            logScanner.startWatching(() => {
                if (combinedWebviewProvider) {
                    combinedWebviewProvider.refresh();
                }
            });
        }

        // Trigger initial refresh after everything is set up
        setTimeout(() => {
            if (combinedWebviewProvider) {
                combinedWebviewProvider.refresh();
            }
        }, 500);

        console.log('RunMate: Extension activation completed successfully');

    } catch (error) {
        console.error('RunMate: Failed to activate extension', error);
        vscode.window.showErrorMessage(`RunMate failed to activate: ${error}`);
    }
}

export function deactivate() {
    if (scriptScanner) {
        scriptScanner.dispose();
    }
    if (logScanner) {
        logScanner.dispose();
    }
    if (executor) {
        executor.dispose();
    }
}