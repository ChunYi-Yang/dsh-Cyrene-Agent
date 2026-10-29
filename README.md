# 如我所书：DSH 中的 Cyrene

在 DSH 的插件页面安装“如我所书”，点击“进入翁法罗斯”，插件会下载并校验配套的 Cyrene 便携程序，然后打开 Cyrene。无需单独安装 Node、克隆开发项目或填写集成目录。

## 当前交付状态

0.2.1 已在隔离 DSH profile 完成原生插件加载、程序包安装、断网复用、欢迎页面实际渲染及正常退出验证，未调用模型。源码发布于 master 分支；配套程序包仍待发布到 GitHub Release，资产发布前其他电脑无法完成在线下载。

## 安装

发布完成后，在 DSH 的“插件 → 添加插件”中输入：

```text
github:ChunYi-Yang/dsh-Cyrene-Agent#master
```

安装并启用插件，按 DSH 提示重载。点击左栏“如我所书 → 进入翁法罗斯”。首次准备时显示下载百分比和解压状态；失败可再次点击重试。当前支持 Windows x64，首次准备需要联网并预留约 3 GiB 空间。程序包约 527 MiB，不包含本地 AI 推理、向量或语音模型。

本机开发验证可在“添加插件”中选择本仓库根目录的绝对路径，但自动下载仍需要配套 Release 资产已经发布。不要选择内部的 plugins 子目录。

## 首次使用

首次打开按 Cyrene 提示阅读免责声明。没有模型配置也可以打开界面；实际对话需要在 DSH 配置可用模型。已有模型通过原生 DSH 接口同步，不将 API Key 写入插件源码。外部 Codex、Claude Code 成员和本地模型可后续按需配置，首次启动不自动安装它们。

程序、连接凭据和用户数据保存在 Windows 本地应用数据目录内，按 DSH profile 分开，插件升级时继续保留。首次安装后，已缓存的同版本程序可以离线打开；在线模型仍需相应网络。Cyrene 退出使用自身保存流程；不改写 DSH 可执行文件。

## 维护与发布

```powershell
pnpm install --ignore-scripts
npm test
node scripts/build-tool-schema.mjs <集成源码目录>
node scripts/build-runtime.mjs <已构建的Cyrene源码目录>
node scripts/audit.mjs .artifacts/runtime-0.2.1/win-unpacked <已构建的Cyrene源码目录>
node scripts/smoke-runtime.mjs <集成源码目录>
```

构建命令只读已有构建结果，输出到被忽略的 .artifacts。发布源码前审查完整待推送提交；上传程序包前还需人工复核二进制资源、许可和元数据。程序包生成后由 runtime-manifest.json 固定版本、下载地址、大小及 SHA-256；不能只替换远端 ZIP 而不更新清单。

将生成的 Cyrene-win32-x64.zip 发布到 runtime-v0.2.1 的 GitHub Release，再发布匹配清单的插件源码。不要把 .artifacts、私人配置、日志、会话或本机安装目录提交到 Git。

## 许可与上游

基于 [Cyrene-Agent](https://github.com/Playa-Cyrene/Cyrene-Agent)，保留 MIT 许可证。程序保留上游版权联系方式与第三方许可证；这些是公开的版权信息，不属于本机账号资料。基础角色资源的使用条件沿用上游说明。
