import * as vscode from 'vscode';
import { ConfigManager } from './config';

export class SecurityChecker {
    private dangerousPatterns: RegExp[] = [
        /rm\s+-rf\s+\/(?:\s|$)/,
        /rm\s+-rf\s+\/\*/,
        /mkfs(?:\s|$)/,
        /:\(\)\{:\|:&\};:/,
        /dd\s+if=\/dev\/(?:zero|random)/,
        /chmod\s+-R\s+777\s+\//,
        />\/dev\/sda/,
        /format\s+[cC]:/,
        /del\s+\/[sS]\s+\/[qQ]\s+[cC]:\\/
    ];

    constructor(private configManager: ConfigManager) {}

    public async checkForDangerousCommands(scriptContent: string, parameters: string): Promise<string | null> {
        const fullCommand = `${scriptContent} ${parameters}`;

        const whitelist = this.configManager.getDangerousCommandsWhitelist();
        const blacklist = this.configManager.getDangerousCommandsBlacklist();

        for (const whitelisted of whitelist) {
            if (fullCommand.includes(whitelisted)) {
                return null;
            }
        }

        for (const blacklisted of blacklist) {
            if (fullCommand.includes(blacklisted)) {
                return blacklisted;
            }
        }

        for (const pattern of this.dangerousPatterns) {
            const match = fullCommand.match(pattern);
            if (match) {
                return match[0];
            }
        }

        const additionalDangerousPatterns = [
            { pattern: /sudo\s+rm\s+-rf/, description: 'sudo rm -rf' },
            { pattern: />\s*\/dev\/null\s+2>&1\s+&\s*$/, description: 'Background process with no output' },
            { pattern: /fork\s*bomb/, description: 'Fork bomb' },
            { pattern: /\bkillall\b/, description: 'killall command' },
            { pattern: /\bpkill\s+-9/, description: 'Force kill processes' },
            { pattern: /iptables\s+-F/, description: 'Flush firewall rules' },
            { pattern: /\bshutdown\b/, description: 'System shutdown' },
            { pattern: /\breboot\b/, description: 'System reboot' }
        ];

        for (const { pattern, description } of additionalDangerousPatterns) {
            if (pattern.test(fullCommand)) {
                return description;
            }
        }

        const suspiciousPatterns = await this.checkSuspiciousPatterns(fullCommand);
        if (suspiciousPatterns) {
            return suspiciousPatterns;
        }

        return null;
    }

    private async checkSuspiciousPatterns(command: string): Promise<string | null> {
        const suspiciousActions = [
            {
                pattern: /curl\s+.*\|\s*(?:bash|sh)/i,
                description: 'Downloading and executing remote script'
            },
            {
                pattern: /wget\s+.*\|\s*(?:bash|sh)/i,
                description: 'Downloading and executing remote script'
            },
            {
                pattern: /eval\s+.*curl/i,
                description: 'Evaluating downloaded content'
            },
            {
                pattern: /base64\s+-d.*\|\s*(?:bash|sh)/i,
                description: 'Executing base64 decoded content'
            },
            {
                pattern: /python\s+-c\s+.*exec/i,
                description: 'Executing dynamic Python code'
            },
            {
                pattern: /perl\s+-e\s+.*system/i,
                description: 'Executing system commands via Perl'
            }
        ];

        for (const { pattern, description } of suspiciousActions) {
            if (pattern.test(command)) {
                const action = await vscode.window.showWarningMessage(
                    `⚠️ Suspicious pattern detected: ${description}\nThis could be potentially harmful. Do you want to continue?`,
                    { modal: true },
                    'Review Script',
                    'Continue Anyway',
                    'Cancel'
                );

                if (action === 'Review Script') {
                    return description;
                } else if (action === 'Cancel' || !action) {
                    return description;
                }
            }
        }

        return null;
    }

    public validateScriptPath(scriptPath: string): boolean {
        const invalidPatterns = [
            /\.\./,
            /^~/,
            /^\/etc/,
            /^\/usr\/bin/,
            /^\/bin/,
            /^\/sbin/,
            /^\/usr\/sbin/
        ];

        for (const pattern of invalidPatterns) {
            if (pattern.test(scriptPath)) {
                vscode.window.showWarningMessage(
                    `Script path "${scriptPath}" might be outside the workspace`
                );
                return false;
            }
        }

        return true;
    }

    public async checkScriptIntegrity(scriptPath: string): Promise<boolean> {
        try {
            const scriptUri = vscode.Uri.file(scriptPath);
            const stat = await vscode.workspace.fs.stat(scriptUri);

            if (stat.size > 10 * 1024 * 1024) {
                const action = await vscode.window.showWarningMessage(
                    'Script file is larger than 10MB. This might cause performance issues. Continue?',
                    'Continue',
                    'Cancel'
                );
                return action === 'Continue';
            }

            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to check script integrity: ${error}`);
            return false;
        }
    }

    public sanitizeParameters(parameters: string): string {
        const dangerousChars = [';', '&&', '||', '|', '`', '$()'];
        let sanitized = parameters;

        for (const char of dangerousChars) {
            if (sanitized.includes(char)) {
                vscode.window.showWarningMessage(
                    `Parameter contains potentially dangerous character: ${char}`
                );
            }
        }

        sanitized = sanitized.replace(/[;&|`$()]/g, '');

        return sanitized;
    }

    public async requestElevatedPermissions(scriptPath: string): Promise<boolean> {
        const scriptContent = await vscode.workspace.fs.readFile(vscode.Uri.file(scriptPath));
        const content = scriptContent.toString();

        if (content.includes('sudo')) {
            const action = await vscode.window.showWarningMessage(
                'This script requires elevated permissions (sudo). Continue?',
                { modal: true },
                'Continue',
                'Cancel'
            );
            return action === 'Continue';
        }

        return true;
    }

    public analyzeScriptComplexity(scriptContent: string): {
        linesOfCode: number;
        functions: number;
        loops: number;
        conditions: number;
        complexity: 'Low' | 'Medium' | 'High';
    } {
        const lines = scriptContent.split('\n');
        const linesOfCode = lines.filter(line => line.trim() && !line.trim().startsWith('#')).length;

        const functions = (scriptContent.match(/function\s+\w+|^\w+\s*\(\)/gm) || []).length;
        const loops = (scriptContent.match(/\b(for|while|until)\b/g) || []).length;
        const conditions = (scriptContent.match(/\b(if|elif|case)\b/g) || []).length;

        let complexity: 'Low' | 'Medium' | 'High' = 'Low';
        const complexityScore = functions * 2 + loops * 3 + conditions;

        if (complexityScore > 20 || linesOfCode > 200) {
            complexity = 'High';
        } else if (complexityScore > 10 || linesOfCode > 100) {
            complexity = 'Medium';
        }

        return {
            linesOfCode,
            functions,
            loops,
            conditions,
            complexity
        };
    }
}
