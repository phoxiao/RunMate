import * as vscode from 'vscode';

interface ScriptUsageData {
    count: number;
    lastExecuted: number;
    lastStatus: string;
}

interface UsageDataMap {
    [scriptPath: string]: ScriptUsageData;
}

interface RecentlyUsedScript {
    scriptPath: string;
    count: number;
    lastExecuted: number;
    lastStatus: string;
}

export class UsageTracker {
    private static readonly STORAGE_KEY = 'runmate.scriptUsage';
    private workspaceState: vscode.Memento;

    constructor(workspaceState: vscode.Memento) {
        this.workspaceState = workspaceState;
    }

    /**
     * Record a script execution
     */
    public recordExecution(scriptPath: string, status: string = 'running'): void {
        const usageData = this.getUsageData();

        if (!usageData[scriptPath]) {
            usageData[scriptPath] = {
                count: 0,
                lastExecuted: Date.now(),
                lastStatus: status
            };
        }

        usageData[scriptPath].count++;
        usageData[scriptPath].lastExecuted = Date.now();
        usageData[scriptPath].lastStatus = status;

        this.saveUsageData(usageData);
    }

    /**
     * Update the last status of a script execution
     */
    public updateStatus(scriptPath: string, status: string): void {
        const usageData = this.getUsageData();

        if (usageData[scriptPath]) {
            usageData[scriptPath].lastStatus = status;
            this.saveUsageData(usageData);
        }
    }

    /**
     * Get the top N most frequently used scripts
     */
    public getTopScripts(limit: number = 5): RecentlyUsedScript[] {
        const usageData = this.getUsageData();

        const scripts: RecentlyUsedScript[] = Object.entries(usageData).map(([scriptPath, data]) => ({
            scriptPath,
            count: data.count,
            lastExecuted: data.lastExecuted,
            lastStatus: data.lastStatus
        }));

        // Sort by count (descending), then by lastExecuted (descending)
        scripts.sort((a, b) => {
            if (b.count !== a.count) {
                return b.count - a.count;
            }
            return b.lastExecuted - a.lastExecuted;
        });

        return scripts.slice(0, limit);
    }

    /**
     * Get usage data for a specific script
     */
    public getScriptUsageData(scriptPath: string): ScriptUsageData | undefined {
        const usageData = this.getUsageData();
        return usageData[scriptPath];
    }

    /**
     * Clean up usage data for scripts that no longer exist
     */
    public async cleanupOldData(existingScripts: Set<string>): Promise<void> {
        const usageData = this.getUsageData();
        let modified = false;

        for (const scriptPath in usageData) {
            if (!existingScripts.has(scriptPath)) {
                delete usageData[scriptPath];
                modified = true;
            }
        }

        if (modified) {
            this.saveUsageData(usageData);
        }
    }

    /**
     * Clear all usage data
     */
    public clearAllData(): void {
        this.workspaceState.update(UsageTracker.STORAGE_KEY, undefined);
    }

    /**
     * Get all usage data from workspace state
     */
    private getUsageData(): UsageDataMap {
        return this.workspaceState.get<UsageDataMap>(UsageTracker.STORAGE_KEY, {});
    }

    /**
     * Save usage data to workspace state
     */
    private saveUsageData(usageData: UsageDataMap): void {
        this.workspaceState.update(UsageTracker.STORAGE_KEY, usageData);
    }
}
