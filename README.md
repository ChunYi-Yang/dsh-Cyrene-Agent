<!--
上游 Cyrene-Agent README 已替换为本仓库的 DSH 插件说明。
请勿把 Cyrene 桌面应用源码、模型、打包资源、开发文档或本机集成数据加入本仓库。
-->

# 如我所书：DSH 插件

“如我所书”是连接 DSH Desktop 与本机 Cyrene 集成的插件，提供桌面切换、共享会话查看与文字续聊、模型目录同步，以及在 Cyrene 中管理 DSH 插件配置等功能。

本仓库分发插件源码。**它不包含 DSH 主程序，也不安装或捆绑 DSH、Cyrene 桌面应用或它们的依赖。** Cyrene 集成目录需要在本机单独安装和配置。

## 安装

1. 确认 DSH Desktop 已安装并能正常启动。
2. 在 GitHub 选择 `release/ruwo-suoxie` 分支下载 ZIP 并解压，或克隆该分支：

   ```powershell
   git clone --depth 1 --single-branch --branch release/ruwo-suoxie https://github.com/ChunYi-Yang/dsh-Cyrene-Agent.git
   ```

3. 在 PowerShell 中切换到克隆出的仓库目录，并用 DSH CLI 把本地插件目录安装到目标 profile：

   ```powershell
   dsh plugin --profile desktop add ./plugins/ruwo-suoxie
   ```

   将 `desktop` 替换为你要使用的 profile 名称。该命令从本地路径安装，不会发布或下载 npm 包。
4. 在 DSH profile 的插件配置中设置 `integrationRoot`，指向本机 Cyrene Next 集成目录的完整路径。
5. 保存配置并重启或按 DSH 要求重载插件，然后在 DSH 侧栏打开“如我所书”。

不需要发布或安装 npm registry 包。若 DSH 版本不支持从本地路径添加 profile 插件，请先确认该版本支持的本地插件安装方式；不要将本仓库作为 DSH 主程序安装。

## 兼容条件

插件使用 DSH 的 `connection`、`sessionController` 和客户端 `slots/layout` 接口，并需要已安装且可运行的 Cyrene Next 集成目录。桌面切换还依赖已验证的 DSH Desktop 接口。插件不携带 DSH 源码，因此不兼容时应停用插件并检查本机 DSH 版本及接口支持情况。

## 隐私与安全

- 不要把 `integrationRoot`、本机路径、Cyrene 会话、模型配置、日志或凭据提交到公开仓库、Issue 或讨论区。
- DSH 模型密钥由本机 DSH 原生凭据服务处理，不打包到插件。
- 插件通过 DSH 认证连接和本机控制接口访问数据，不开放公网控制端口，也不接收任意 shell 命令。
- 插件代码在 DSH 进程内运行并具有该进程的权限。安装前请审阅源码，只安装你信任的代码。

## 获取更新

从本 GitHub 仓库下载新版本并按 DSH 的本地插件更新流程重新安装。本项目只上传 GitHub，不发布 npm 包。

## 上游项目

本仓库基于 [Cyrene-Agent](https://github.com/Playa-Cyrene/Cyrene-Agent) 项目。Cyrene 桌面应用源码与本插件分开维护和安装。
