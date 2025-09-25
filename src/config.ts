import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface RunMateConfig {
    ignoreDirectories: string[];
    defaultWorkingDirectory: string;
    customSort: string[];
    dangerousCommandsWhitelist: string[];
    dangerousCommandsBlacklist: string[];
}

export class ConfigManager {
    private config: RunMateConfig | null = null;
    private configPath: string | null = null;
    private fileWatcher: vscode.FileSystemWatcher | undefined;

    constructor() {
        this.loadConfiguration();
        this.watchConfigFile();
    }

    private async loadConfiguration(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.loadDefaultConfig();
            return;
        }

        this.configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'run-mate.json');

        try {
            if (await fs.pathExists(this.configPath)) {
                const configContent = await fs.readFile(this.configPath, 'utf8');
                const fileConfig = JSON.parse(configContent) as Partial<RunMateConfig>;
                this.config = this.mergeWithDefaults(fileConfig);
            } else {
                this.loadDefaultConfig();
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load RunMate configuration: ${error}`);
            this.loadDefaultConfig();
        }
    }

    private loadDefaultConfig(): void {
        const vsConfig = vscode.workspace.getConfiguration('runmate');

        this.config = {
            ignoreDirectories: vsConfig.get<string[]>('ignoreDirectories', ['node_modules', '.git', 'dist', 'out', 'build']),
            defaultWorkingDirectory: vsConfig.get<string>('defaultWorkingDirectory', './'),
            customSort: vsConfig.get<string[]>('customSort', []),
            dangerousCommandsWhitelist: vsConfig.get<string[]>('dangerousCommandsWhitelist', []),
            dangerousCommandsBlacklist: vsConfig.get<string[]>('dangerousCommandsBlacklist', [
                'rm -rf /',
                'rm -rf /*',
                'mkfs',
                ':(){:|:&};:',
                'dd if=/dev/zero',
                'chmod -R 777 /',
                'sudo rm -rf'
            ])
        };
    }

    private mergeWithDefaults(fileConfig: Partial<RunMateConfig>): RunMateConfig {
        const vsConfig = vscode.workspace.getConfiguration('runmate');

        return {
            ignoreDirectories: fileConfig.ignoreDirectories ??
                vsConfig.get<string[]>('ignoreDirectories', ['node_modules', '.git', 'dist', 'out', 'build']),
            defaultWorkingDirectory: fileConfig.defaultWorkingDirectory ??
                vsConfig.get<string>('defaultWorkingDirectory', './'),
            customSort: fileConfig.customSort ??
                vsConfig.get<string[]>('customSort', []),
            dangerousCommandsWhitelist: fileConfig.dangerousCommandsWhitelist ??
                vsConfig.get<string[]>('dangerousCommandsWhitelist', []),
            dangerousCommandsBlacklist: fileConfig.dangerousCommandsBlacklist ??
                vsConfig.get<string[]>('dangerousCommandsBlacklist', [
                    'rm -rf /',
                    'rm -rf /*',
                    'mkfs',
                    ':(){:|:&};:',
                    'dd if=/dev/zero',
                    'chmod -R 777 /',
                    'sudo rm -rf'
                ])
        };
    }

    private watchConfigFile(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const pattern = new vscode.RelativePattern(
            workspaceFolder,
            '.vscode/run-mate.json'
        );

        this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        this.fileWatcher.onDidChange(() => {
            this.loadConfiguration();
            vscode.window.showInformationMessage('RunMate configuration reloaded');
        });

        this.fileWatcher.onDidCreate(() => {
            this.loadConfiguration();
            vscode.window.showInformationMessage('RunMate configuration file created and loaded');
        });

        this.fileWatcher.onDidDelete(() => {
            this.loadDefaultConfig();
            vscode.window.showInformationMessage('RunMate configuration file deleted, using defaults');
        });

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('runmate')) {
                this.loadConfiguration();
            }
        });
    }

    public getIgnoreDirectories(): string[] {
        return this.config?.ignoreDirectories || ['node_modules', '.git'];
    }

    public getDefaultWorkingDirectory(): string {
        return this.config?.defaultWorkingDirectory || './';
    }

    public getCustomSort(): string[] {
        return this.config?.customSort || [];
    }

    public getDangerousCommandsWhitelist(): string[] {
        return this.config?.dangerousCommandsWhitelist || [];
    }

    public getDangerousCommandsBlacklist(): string[] {
        return this.config?.dangerousCommandsBlacklist || [
            'rm -rf /',
            'rm -rf /*',
            'mkfs',
            ':(){:|:&};:'
        ];
    }

    public async saveConfiguration(config: Partial<RunMateConfig>): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder to save configuration');
            return;
        }

        const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'run-mate.json');

        try {
            await fs.ensureDir(path.dirname(configPath));

            const currentConfig = await this.readConfigFile();
            const newConfig = { ...currentConfig, ...config };

            await fs.writeFile(
                configPath,
                JSON.stringify(newConfig, null, 2),
                'utf8'
            );

            this.config = this.mergeWithDefaults(newConfig);
            vscode.window.showInformationMessage('RunMate configuration saved');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save configuration: ${error}`);
        }
    }

    private async readConfigFile(): Promise<Partial<RunMateConfig>> {
        if (!this.configPath || !(await fs.pathExists(this.configPath))) {
            return {};
        }

        try {
            const content = await fs.readFile(this.configPath, 'utf8');
            return JSON.parse(content) as Partial<RunMateConfig>;
        } catch {
            return {};
        }
    }

    public dispose(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
    }
}
