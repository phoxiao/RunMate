import * as vscode from 'vscode';
import { ScriptTreeProvider } from './scriptTreeView';
import { ScriptScanner } from './scriptScanner';
import { Executor } from './executor';
import { ConfigManager } from './config';
import { SecurityChecker } from './security';

let scriptTreeProvider: ScriptTreeProvider;
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

        const refreshCommand = vscode.commands.registerCommand('runmate.refreshScripts', () => {
            console.log('RunMate: Manual refresh triggered');
            if (scriptTreeProvider) {
                scriptTreeProvider.refresh();
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
            let parameters = '';

            if (config.get<boolean>('rememberLastParameters')) {
                const lastParams = context.workspaceState.get<string>(`params_${scriptItem.filePath}`);
                if (lastParams) {
                    parameters = lastParams;
                }
            }

            const input = await vscode.window.showInputBox({
                prompt: `Enter parameters for ${scriptItem.label}`,
                placeHolder: 'Optional: Enter script parameters',
                value: parameters
            });

            if (input !== undefined) {
                if (config.get<boolean>('rememberLastParameters') && input) {
                    await context.workspaceState.update(`params_${scriptItem.filePath}`, input);
                }

                const confirmExecution = config.get<boolean>('confirmBeforeExecute', true);
                if (confirmExecution) {
                    const scriptName = scriptItem.label;
                    const scriptPath = scriptItem.filePath;
                    const paramText = input ? ` with parameters: ${input}` : '';

                    const confirmation = await vscode.window.showQuickPick(
                        [
                            {
                                label: '$(play) Execute',
                                description: 'Run the script now',
                                detail: `${scriptPath}${paramText}`
                            },
                            {
                                label: '$(x) Cancel',
                                description: 'Do not execute the script',
                                detail: 'Script execution will be cancelled'
                            }
                        ],
                        {
                            placeHolder: `Execute script: ${scriptName}?`,
                            title: 'Script Execution Confirmation',
                            ignoreFocusOut: true
                        }
                    );

                    if (!confirmation || confirmation.label.includes('Cancel')) {
                        return;
                    }
                }

                await executor.executeScript(scriptItem.filePath, input || '');
                // Refresh will be triggered by executor's onStatusChanged event
            }
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

        // NOW create tree provider and tree view AFTER commands are registered
        scriptTreeProvider = new ScriptTreeProvider(scriptScanner, executor);

        // Register the tree view
        const treeView = vscode.window.createTreeView('runmate.scriptView', {
            treeDataProvider: scriptTreeProvider,
            showCollapseAll: true,
            canSelectMany: false
        });
        context.subscriptions.push(treeView);
        console.log('RunMate: Tree view created successfully');

        // Perform initial scan
        await scriptScanner.scanScripts();
        console.log('RunMate: Initial scan completed');

        // Listen for script status changes to refresh the tree
        executor.onStatusChanged((scriptPath) => {
            console.log(`RunMate: Status changed for script: ${scriptPath}, refreshing tree`);
            scriptTreeProvider.refresh();
        });

        // Setup auto-refresh if enabled
        const config = vscode.workspace.getConfiguration('runmate');
        if (config.get<boolean>('autoRefresh')) {
            scriptScanner.startWatching(() => {
                scriptTreeProvider.refresh();
            });
        }

        // Handle tree view selection
        treeView.onDidChangeSelection(e => {
            if (e.selection.length > 0) {
                const item = e.selection[0];
                if (item.contextValue === 'script' || item.contextValue === 'running') {
                    vscode.commands.executeCommand('runmate.openScript', item);
                }
            }
        });

        context.subscriptions.push(scriptScanner);

        // Trigger initial refresh after everything is set up
        setTimeout(() => {
            scriptTreeProvider.refresh();
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