import * as vscode from 'vscode';
import { ScriptWebviewProvider } from './scriptWebviewProvider';
import { ScriptScanner } from './scriptScanner';
import { Executor } from './executor';
import { ConfigManager } from './config';
import { SecurityChecker } from './security';

let scriptWebviewProvider: ScriptWebviewProvider;
let scriptScanner: ScriptScanner;
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

        // Register ALL commands FIRST, before creating tree view
        // This ensures commands exist when the tree view tries to use them

        const refreshCommand = vscode.commands.registerCommand('runmate.refreshScripts', async () => {
            console.log('RunMate: Manual refresh triggered');
            await scriptScanner.scanScripts();
            if (scriptWebviewProvider) {
                scriptWebviewProvider.refresh();
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

        console.log('RunMate: All commands registered successfully');

        // Create and register the WebviewViewProvider
        scriptWebviewProvider = new ScriptWebviewProvider(
            context.extensionUri,
            scriptScanner,
            executor,
            context
        );

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                ScriptWebviewProvider.viewType,
                scriptWebviewProvider,
                {
                    webviewOptions: {
                        retainContextWhenHidden: true
                    }
                }
            )
        );
        console.log('RunMate: Webview provider registered successfully');

        // Perform initial scan
        await scriptScanner.scanScripts();
        console.log('RunMate: Initial scan completed');

        // Setup auto-refresh if enabled
        const config = vscode.workspace.getConfiguration('runmate');
        if (config.get<boolean>('autoRefresh')) {
            scriptScanner.startWatching(() => {
                if (scriptWebviewProvider) {
                    scriptWebviewProvider.refresh();
                }
            });
        }

        context.subscriptions.push(scriptScanner);

        // Trigger initial refresh after everything is set up
        setTimeout(() => {
            if (scriptWebviewProvider) {
                scriptWebviewProvider.refresh();
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
    if (executor) {
        executor.dispose();
    }
}