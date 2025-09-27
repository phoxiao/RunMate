import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from './config';

export interface LogFile {
    name: string;
    path: string;
    directory: string;
    size: number;
    modified: Date;
}

export class LogScanner implements vscode.Disposable {
    private logs: Map<string, LogFile[]> = new Map();
    private watcher: vscode.FileSystemWatcher | undefined;
    private onLogsChangedEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onLogsChanged = this.onLogsChangedEmitter.event;

    constructor(_configManager: ConfigManager) {
    }

    public async scanLogs(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            console.log('RunMate: No workspace folder found');
            return;
        }

        console.log('RunMate: Starting log scan...');
        this.logs.clear();

        // Get configured log file types
        const config = vscode.workspace.getConfiguration('runmate');
        const logFileTypes = config.get<string[]>('logFileTypes', ['*.log', '*.out', '*.err', '*.txt']);
        const ignoreDirectories = config.get<string[]>('logIgnoreDirectories', ['node_modules', '.git', 'dist', 'out', 'build']);
        const maxFileSize = config.get<number>('maxLogFileSize', 10); // MB

        // Build glob pattern
        const includePattern = `**/{${logFileTypes.join(',')}}`;
        const excludePattern = `**/{${ignoreDirectories.join(',')}}/**`;

        try {
            const files = await vscode.workspace.findFiles(
                includePattern,
                excludePattern,
                1000 // Max results
            );

            console.log(`RunMate: Found ${files.length} log files`);

            for (const file of files) {
                try {
                    const stats = fs.statSync(file.fsPath);

                    // Skip files that are too large
                    const fileSizeMB = stats.size / (1024 * 1024);
                    if (fileSizeMB > maxFileSize) {
                        console.log(`RunMate: Skipping large log file ${file.fsPath} (${fileSizeMB.toFixed(2)} MB)`);
                        continue;
                    }

                    const relativePath = path.relative(workspaceFolder.uri.fsPath, file.fsPath);
                    const directory = path.dirname(relativePath);
                    const fileName = path.basename(file.fsPath);

                    const logFile: LogFile = {
                        name: fileName,
                        path: file.fsPath,
                        directory: directory === '.' ? 'root' : directory,
                        size: stats.size,
                        modified: stats.mtime
                    };

                    // Group by directory
                    if (!this.logs.has(logFile.directory)) {
                        this.logs.set(logFile.directory, []);
                    }
                    this.logs.get(logFile.directory)!.push(logFile);

                } catch (error) {
                    console.error(`RunMate: Error processing log file ${file.fsPath}:`, error);
                }
            }

            // Sort logs within each directory
            for (const logFiles of this.logs.values()) {
                logFiles.sort((a, b) => {
                    // Sort by modified date (newest first)
                    return b.modified.getTime() - a.modified.getTime();
                });
            }

            console.log(`RunMate: Log scan completed. Found ${this.logs.size} directories with logs`);
            this.onLogsChangedEmitter.fire();

        } catch (error) {
            console.error('RunMate: Error scanning for log files:', error);
            vscode.window.showErrorMessage(`Failed to scan log files: ${error}`);
        }
    }

    public startWatching(callback: () => void): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        // Get configured log file types
        const config = vscode.workspace.getConfiguration('runmate');
        const logFileTypes = config.get<string[]>('logFileTypes', ['*.log', '*.out', '*.err', '*.txt']);

        // Create file system watcher for log files
        const pattern = new vscode.RelativePattern(
            workspaceFolder,
            `**/{${logFileTypes.join(',')}}`
        );

        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

        // Set up event handlers
        const rescan = async () => {
            await this.scanLogs();
            callback();
        };

        this.watcher.onDidCreate(rescan);
        this.watcher.onDidDelete(rescan);
        this.watcher.onDidChange(rescan);

        console.log('RunMate: Started watching for log file changes');
    }

    public stopWatching(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
            console.log('RunMate: Stopped watching for log file changes');
        }
    }

    public getLogs(): Map<string, LogFile[]> {
        return this.logs;
    }

    public getLogCount(): number {
        let count = 0;
        for (const logs of this.logs.values()) {
            count += logs.length;
        }
        return count;
    }

    public async deleteLog(logPath: string): Promise<void> {
        try {
            const fileUri = vscode.Uri.file(logPath);
            await vscode.workspace.fs.delete(fileUri);

            // Remove from internal list
            for (const [dir, logs] of this.logs.entries()) {
                const index = logs.findIndex(log => log.path === logPath);
                if (index !== -1) {
                    logs.splice(index, 1);
                    if (logs.length === 0) {
                        this.logs.delete(dir);
                    }
                    break;
                }
            }

            this.onLogsChangedEmitter.fire();
            console.log(`RunMate: Deleted log file: ${logPath}`);
        } catch (error) {
            console.error(`RunMate: Failed to delete log file ${logPath}:`, error);
            throw error;
        }
    }

    public formatFileSize(bytes: number): string {
        if (bytes < 1024) {
            return `${bytes} B`;
        } else if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} KB`;
        } else {
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        }
    }

    public dispose(): void {
        this.stopWatching();
        this.onLogsChangedEmitter.dispose();
    }
}