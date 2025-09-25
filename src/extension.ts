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

export function activate(context: vscode.ExtensionContext) {
    console.log('RunMate extension is now active');

    configManager = new ConfigManager();
    const securityChecker = new SecurityChecker(configManager);
    executor = new Executor(context, securityChecker, configManager);
    scriptScanner = new ScriptScanner(configManager);
    scriptTreeProvider = new ScriptTreeProvider(scriptScanner, executor);

    const treeView = vscode.window.createTreeView('runmate.scriptView', {
        treeDataProvider: scriptTreeProvider,
        showCollapseAll: true,
        canSelectMany: false
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('runmate.runScript', async (scriptItem) => {
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
                    const confirmation = await vscode.window.showWarningMessage(
                        `Execute script: ${scriptItem.filePath}${input ? ` with parameters: ${input}` : ''}?`,
                        'Execute',
                        'Cancel'
                    );

                    if (confirmation !== 'Execute') {
                        return;
                    }
                }

                await executor.executeScript(scriptItem.filePath, input || '');
                // Delay refresh slightly to allow execution status to update
                setTimeout(() => scriptTreeProvider.refresh(), 100);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('runmate.stopScript', async (scriptItem) => {
            if (!scriptItem) {
                vscode.window.showErrorMessage('No script selected');
                return;
            }

            await executor.stopScript(scriptItem.filePath);
            // Delay refresh slightly to ensure status is updated
            setTimeout(() => scriptTreeProvider.refresh(), 100);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('runmate.refreshScripts', () => {
            scriptTreeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('runmate.openScript', (scriptItem) => {
            if (scriptItem) {
                vscode.workspace.openTextDocument(scriptItem.filePath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('runmate.openConfig', async () => {
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
        })
    );

    const config = vscode.workspace.getConfiguration('runmate');
    if (config.get<boolean>('autoRefresh')) {
        scriptScanner.startWatching(() => {
            scriptTreeProvider.refresh();
        });
    }

    treeView.onDidChangeSelection(e => {
        if (e.selection.length > 0) {
            const item = e.selection[0];
            if (item.contextValue === 'script' || item.contextValue === 'running') {
                vscode.commands.executeCommand('runmate.openScript', item);
            }
        }
    });

    context.subscriptions.push(treeView);
    context.subscriptions.push(scriptScanner);
}

export function deactivate() {
    if (scriptScanner) {
        scriptScanner.dispose();
    }
    if (executor) {
        executor.dispose();
    }
}
