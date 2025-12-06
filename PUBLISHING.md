# 发布指南 (Publishing Guide)

本文档说明如何自动发布 RunMate 扩展到 VS Code Marketplace 和 Open VSX Registry。

## 自动发布流程

### 触发方式

发布会在以下情况下自动触发：

1. **推送版本标签** (推荐)
```bash
# 1. 更新 package.json 中的版本号
npm version patch  # 或 minor, major

# 2. 推送标签到 GitHub
git push origin v1.0.3  # 替换为实际版本号
```

2. **手动触发**
- 访问 GitHub Actions 页面
- 选择 "Release and Publish" workflow
- 点击 "Run workflow"
- 输入版本号（如 1.0.3）

### 发布流程

当标签被推送后，GitHub Actions 会自动：

1. ✅ 运行测试
2. ✅ 编译 TypeScript
3. ✅ 打包扩展为 `.vsix` 文件
4. ✅ 创建 GitHub Release 并上传 `.vsix`
5. ✅ 发布到 VS Code Marketplace（如果配置了 token）
6. ✅ 发布到 Open VSX Registry（如果配置了 token）

## 配置 Marketplace Token

### 1. Visual Studio Marketplace Token

#### 获取 Token

1. 访问 [Azure DevOps](https://dev.azure.com/)
2. 登录后，点击右上角用户图标 → "Personal access tokens"
3. 点击 "New Token"
4. 配置：
   - **Name**: `vscode-marketplace-publish`
   - **Organization**: 选择 "All accessible organizations"
   - **Expiration**: 选择合适的过期时间（建议 90 天或自定义）
   - **Scopes**: 点击 "Show all scopes"，找到并勾选：
     - ✅ **Marketplace** → **Manage**
5. 点击 "Create"
6. **立即复制 token**（只显示一次）

#### 配置 Publisher

首先需要在 VS Code Marketplace 创建 publisher：

1. 访问 [Visual Studio Marketplace Publisher Management](https://marketplace.visualstudio.com/manage)
2. 点击 "Create publisher"
3. 填写信息：
   - **ID**: 选择唯一的 publisher ID（如 `your-company-name`）
   - **Name**: 显示名称
   - **Email**: 联系邮箱
4. 创建后，更新 [package.json](package.json) 中的 `publisher` 字段为你的 publisher ID

#### 添加到 GitHub Secrets

1. 访问你的 GitHub 仓库
2. 进入 **Settings** → **Secrets and variables** → **Actions**
3. 点击 "New repository secret"
4. 添加：
   - **Name**: `VS_MARKETPLACE_TOKEN`
   - **Secret**: 粘贴上面复制的 token
5. 点击 "Add secret"

### 2. Open VSX Registry Token (可选)

Open VSX 是 VS Code Marketplace 的开源替代品，Eclipse Foundation 维护。

#### 获取 Token

1. 访问 [Open VSX Registry](https://open-vsx.org/)
2. 使用 GitHub 账号登录
3. 点击右上角用户图标 → "Access Tokens"
4. 点击 "Generate New Token"
5. 复制生成的 token

#### 添加到 GitHub Secrets

1. 在 GitHub 仓库的 **Settings** → **Secrets and variables** → **Actions**
2. 点击 "New repository secret"
3. 添加：
   - **Name**: `OPEN_VSX_TOKEN`
   - **Secret**: 粘贴 Open VSX token
4. 点击 "Add secret"

## 发布步骤

### 完整发布流程

```bash
# 1. 确保所有更改已提交
git status

# 2. 更新版本号（会自动创建 git tag）
npm version patch   # 1.0.2 → 1.0.3
# 或者
npm version minor   # 1.0.2 → 1.1.0
# 或者
npm version major   # 1.0.2 → 2.0.0

# 3. 推送代码和标签
git push origin main
git push origin --tags

# 4. GitHub Actions 会自动处理剩余步骤
```

### 仅发布到 GitHub Release (不发布到 Marketplace)

如果只想创建 GitHub Release 而不发布到 Marketplace：

1. 不要配置 `VS_MARKETPLACE_TOKEN` 和 `OPEN_VSX_TOKEN`
2. 按照上述流程推送标签
3. 只会创建 GitHub Release，不会发布到商店

### 手动发布（本地）

如果需要手动发布：

```bash
# 1. 安装 vsce
npm install -g @vscode/vsce

# 2. 登录 (首次)
vsce login <your-publisher-name>
# 输入上面获取的 Personal Access Token

# 3. 发布
vsce publish
# 或指定版本类型
vsce publish patch
vsce publish minor
vsce publish major
```

## 版本号说明

遵循 [Semantic Versioning](https://semver.org/) (语义化版本)：

- **patch** (1.0.0 → 1.0.1): 错误修复、小改进
- **minor** (1.0.0 → 1.1.0): 新功能、向后兼容
- **major** (1.0.0 → 2.0.0): 重大变更、破坏性更新

## 验证发布

### 检查 GitHub Release
- 访问 `https://github.com/phoxiao/RunMate/releases`
- 确认最新版本已创建
- 下载 `.vsix` 文件测试安装

### 检查 VS Code Marketplace
- 访问 `https://marketplace.visualstudio.com/items?itemName=<publisher>.<extension-name>`
- 确认版本号已更新
- 或在 VS Code 中搜索 "RunMate" 查看

### 检查 Open VSX
- 访问 `https://open-vsx.org/extension/<publisher>/<extension-name>`
- 确认版本号已更新

## 故障排查

### 发布失败

1. **检查 GitHub Actions 日志**
   - 访问 Actions 标签页
   - 查看失败的 workflow 运行日志

2. **常见错误**

   **Token 无效或过期**
   ```
   Error: Failed to publish. The Personal Access Token verification has failed.
   ```
   → 解决：重新生成 token 并更新 GitHub Secrets

   **Publisher 不存在**
   ```
   Error: Publisher '<name>' not found.
   ```
   → 解决：在 Marketplace 创建 publisher 并更新 package.json

   **版本已存在**
   ```
   Error: Extension '<name>' already has a version '<version>'.
   ```
   → 解决：增加版本号

   **测试失败**
   ```
   Error: Tests failed
   ```
   → 解决：本地运行 `npm test` 修复测试

### 本地测试打包

在发布前，可以本地测试打包：

```bash
# 安装 vsce
npm install -g @vscode/vsce

# 打包（不发布）
vsce package

# 会生成 runmate-1.0.3.vsix 文件
# 手动安装测试：
# 1. 打开 VS Code
# 2. Extensions 视图 → "..." → "Install from VSIX..."
# 3. 选择生成的 .vsix 文件
```

## 回滚版本

如果发布的版本有问题：

### 1. 从 Marketplace 取消发布

```bash
vsce unpublish <publisher>.<extension-name>@<version>
# 或取消发布整个扩展
vsce unpublish <publisher>.<extension-name>
```

### 2. 从 GitHub 删除 Release

1. 访问 Releases 页面
2. 编辑或删除有问题的 release
3. 删除对应的 git tag：
```bash
git tag -d v1.0.3
git push origin :refs/tags/v1.0.3
```

## 最佳实践

1. **发布前检查清单**
   - [ ] 所有测试通过 (`npm test`)
   - [ ] 本地编译成功 (`npm run compile`)
   - [ ] CHANGELOG.md 已更新
   - [ ] README.md 版本信息准确
   - [ ] 本地测试 `.vsix` 安装和功能

2. **版本管理**
   - 使用 `npm version` 自动更新版本和创建 tag
   - 在 CHANGELOG.md 记录每个版本的更改
   - 为重大版本创建 pre-release 测试

3. **安全性**
   - 定期更新 Personal Access Token（设置过期时间）
   - 不要在代码中硬编码 token
   - 只给 token 必要的权限（Marketplace: Manage）

4. **发布频率**
   - Bug fixes: 尽快发布 patch 版本
   - 新功能: 积累后发布 minor 版本
   - 破坏性变更: 谨慎发布 major 版本，提前通知用户

## 参考链接

- [VS Code Extension Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [vsce CLI Documentation](https://github.com/microsoft/vscode-vsce)
- [Azure DevOps Personal Access Tokens](https://docs.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)
- [Open VSX Registry](https://open-vsx.org/)
- [Semantic Versioning](https://semver.org/)
