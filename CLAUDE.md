# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RunMate is a VS Code extension for discovering and executing shell scripts directly from the VS Code sidebar. Currently in specification phase with implementation pending.

## Development Commands

### Initial Setup (when implemented)
```bash
npm install              # Install dependencies
npm run compile         # Compile TypeScript
npm run watch          # Watch mode for development
npm run test           # Run tests
npm run lint           # Run ESLint
npm run package        # Package extension as .vsix
```

### VS Code Extension Development
```bash
# Press F5 in VS Code to launch Extension Development Host
# Or use: code --extensionDevelopmentPath=.
```

## Architecture

### Core Components (to be implemented)
- **src/extension.ts**: Extension entry point, registers commands and providers
- **src/scriptScanner.ts**: Discovers shell scripts using glob patterns, watches for file changes
- **src/scriptTreeView.ts**: TreeDataProvider for VS Code sidebar panel
- **src/executor.ts**: Handles script execution with terminal management
- **src/config.ts**: Configuration management via VS Code settings
- **src/security.ts**: Security checks for dangerous commands

### Key Design Patterns
- TreeDataProvider pattern for sidebar UI
- File watcher for real-time script discovery
- Terminal API for script execution
- Configuration contribution points for user settings

### VS Code Extension Structure
```
package.json           # Extension manifest with contributes section
src/
  extension.ts        # activate() and deactivate() functions
  scriptScanner.ts    # Glob-based file discovery
  scriptTreeView.ts   # TreeDataProvider implementation
  executor.ts         # Terminal creation and management
  config.ts          # workspace.getConfiguration() wrapper
  security.ts        # Command safety validation
```

## Implementation Guidelines

### Script Discovery
- Use vscode.workspace.findFiles() with glob patterns
- Implement FileSystemWatcher for real-time updates
- Support configurable include/exclude patterns

### TreeView Implementation
- Extend vscode.TreeDataProvider<ScriptItem>
- Implement getTreeItem() and getChildren() methods
- Use command contributions for context menu actions

### Script Execution
- Create terminals via vscode.window.createTerminal()
- Handle parameter substitution with ${param} syntax
- Store parameter history in workspace state

### Configuration
- Define contributes.configuration in package.json
- Access via vscode.workspace.getConfiguration('runmate')
- Support workspace-specific overrides

## Testing Approach
```bash
npm run test           # Run unit tests
npm run test:e2e      # Run VS Code extension tests (when implemented)
```

Test files should be co-located with source files as `*.test.ts`

## Platform Support
- macOS and Linux only
- No Windows support (incompatible shell script formats)

## Security Considerations
- Scan scripts for dangerous patterns (rm -rf, sudo, etc.)
- Require user confirmation for first-time script execution
- Display warnings for potentially destructive operations