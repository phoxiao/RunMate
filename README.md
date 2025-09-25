# RunMate - Shell Script Manager for VS Code

RunMate is a VS Code extension that automatically discovers and manages shell scripts in your workspace, providing a convenient sidebar panel for quick execution and management.

## Features

- **Automatic Script Discovery**: Finds all `.sh` files in your workspace
- **TreeView Panel**: Organized display of scripts by directory
- **Quick Execution**: Run scripts with a single click
- **Parameter Support**: Input and remember script parameters
- **Real-time Updates**: Automatically refreshes when scripts are added/removed
- **Security Checks**: Detects dangerous commands and requires confirmation
- **Execution Status**: Visual indicators for running/success/failed scripts
- **Concurrent Execution**: Run multiple scripts simultaneously

## Installation

1. Install dependencies: `npm install`
2. Compile TypeScript: `npm run compile`
3. Press F5 in VS Code to launch the Extension Development Host

## Usage

1. Open a workspace containing shell scripts
2. The RunMate panel appears in the Activity Bar
3. Click on any script to execute it
4. Enter parameters when prompted (optional)
5. View output in the integrated terminal

## Configuration

### VS Code Settings

Configure RunMate through VS Code settings:

- `runmate.ignoreDirectories`: Directories to exclude from scanning
- `runmate.defaultWorkingDirectory`: Default execution directory
- `runmate.customSort`: Custom script ordering
- `runmate.dangerousCommandsBlacklist`: Commands requiring confirmation
- `runmate.confirmBeforeExecute`: Show confirmation before execution
- `runmate.rememberLastParameters`: Remember script parameters

### Project Configuration

Create `.vscode/run-mate.json` for project-specific settings:

```json
{
  "ignoreDirectories": ["node_modules", ".git"],
  "defaultWorkingDirectory": "./",
  "customSort": ["deploy.sh", "build.sh"],
  "dangerousCommandsWhitelist": ["rm -rf ./tmp"],
  "dangerousCommandsBlacklist": ["rm -rf /", "mkfs"]
}
```

## Security

RunMate includes built-in security features:

- Dangerous command detection
- Execution confirmation dialogs
- Automatic permission management
- Parameter sanitization

## Development

### Build and Test

```bash
npm run compile    # Compile TypeScript
npm run watch      # Watch mode
npm run lint       # Run ESLint
npm run test       # Run tests
npm run package    # Create VSIX package
```

### Project Structure

```
src/
├── extension.ts       # Extension entry point
├── scriptScanner.ts   # File discovery
├── scriptTreeView.ts  # UI components
├── executor.ts        # Script execution
├── config.ts          # Configuration management
└── security.ts        # Security checks
```

## Requirements

- VS Code 1.74.0 or higher
- macOS or Linux (Windows not supported)
- Node.js 16.x or higher

## License

MIT