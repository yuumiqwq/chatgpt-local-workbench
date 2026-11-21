# macOS：共用仓库与自动更新

ROG、Legion 与 macOS Workbench 使用同一个 GitHub 源仓库 https://github.com/yuumiqwq/chatgpt-local-workbench ，各主机独立检出 main 并跟踪 origin/main。各主机的工作区注册表、Host Policy、隧道配置、会话记录及凭据始终保存在仓库之外。Legion 的云手机开关、ADB 路径、授权资料、设备状态和运行时锁保留在 Legion 本机；公共源码中可以继续包含手机模块，其他主机不启用该模块。

Windows 两台已有独立版本目录和计划任务部署。macOS 沿用相同的安全部署逻辑：每 15 分钟由用户级 launchd 触发一次更新协调器，检查 origin/main，等待任务空闲，再将新提交安装和测试到独立版本目录。验证完成后停止本机旧隧道、原子切换活动版本指针，并重新启动原隧道。Mac 的系统级启动和隧道操作必须沿用这台电脑现有的运行账户，不共享 Windows 的配置和凭据。

## 接入前提

需要 macOS 上已安装 Node.js 22 或以上、Git、npm，并且已能启动原有的 MCP 隧道。macOS 需要一份本机 Git checkout，例如用户主目录下的 Developer/chatgpt-local-workbench；仓库检出分支必须是 main、跟踪 origin/main，且工作树干净。首次接入应先验证现有服务与隧道 ID、工作记录存放路径及真实启动命令。

私有文件可以存放在用户 Library/Application Support/Masked Workbench/config 下。此目录必须位于源码 checkout 外，使用当前 macOS 登录用户能够读写的权限。Git checkout 仅存放公共代码，不写入任何本机凭据或手机状态。

## 配置方式

首先准备私有的 git-deploy.json。字段与 docs/windows-git-deployment.md 中相同，所有路径改成 Mac 的绝对路径。特别需要设置：

- repository：本机共享仓库 checkout 目录。
- state_directory：仓库外的部署事件和运行状态目录。
- work_registries：本机全部 Workbench 工作记录 JSON 路径。
- protected_files：工作区、Host Policy、隧道 profile、启动脚本和其他不可被部署改变的私有文件。
- npm_cli：本机 npm 的 npm-cli.js 绝对路径。不要依赖 launchd 的交互式 shell PATH。
- tunnel.id：这台 Mac 原先使用的隧道 ID，不重新创建隧道。
- tunnel.status / stop / start：现有的隧道管理命令及参数，采用绝对可执行路径，保持同一隧道身份。status 必须输出 deploy-windows.mjs 要求的 JSON，包括 tunnel_id、process_running、healthy、ready 和运行时 PID。
- releases.directory：仓库外的独立版本目录。
- releases.pointer：仓库外的活动版本 JSON 指针。
- agent_desktop.enabled：macOS 不适用 Windows 的可选桌面依赖安装，可以显式设置 false。

现有隧道的 Bridge 进程启动入口需要使用公共仓库提供的版本选择器。以下为命令参数结构，路径根据 Mac 现有部署位置填写：

    node scripts/start-workbench-from-release.mjs --releases /absolute/private/workbench-releases --pointer /absolute/private/active-release.json --fallback /absolute/checkout

首次启用活动版本之前，版本选择器会启动已构建的 checkout。部署成功后，它会读取经过校验的活动版本指针，执行独立版本目录的 dist/src/mcp-stdio.js。现有运行时需要传入的参数可以放在末尾的 -- 后面，原有环境变量和工作区配置保持不变。需要提前完成 npm ci 和 npm run build，确保首次启动的 checkout 有 dist。

然后建立独立的 auto-update.json 文件：

    {
      "version": 1,
      "hostname": "通过本机 Node.js os.hostname() 取得的准确主机名",
      "deployment_config": "/absolute/private/git-deploy.json"
    }

该配置可以选择性增加 guardian 和 phone_state_directory，其中 phone_state_directory 仅供带有手机操作锁的主机使用，Masked 通常无须配置。Mac 的 hostname 必须与当前主机一致。

## 启用与验证

完成私有配置及版本选择器接入后，先执行只读部署检查，并确认本机隧道状态字段正确：

    node scripts/deploy-windows.mjs check --config /absolute/private/git-deploy.json

完成检查后，由 Mac 的现有运行账户安装 launchd 用户任务：

    node scripts/install-macos-auto-update.mjs --config /absolute/private/auto-update.json

安装器验证机器身份、私有部署配置及独立版本目录，写入用户 Library/LaunchAgents/com.yuumi.workbench.auto-update.plist，并在当前登录用户的 GUI launchd 域注册任务。安装过程不替换工作区配置、不创建新的隧道，也不向共享仓库提交本机路径。若先前任务已使用本工具安装，会原位更新；遇到非本工具创建的同名配置则停止。

安装后检查：

    launchctl print gui/$(id -u)/com.yuumi.workbench.auto-update

最近一次更新状态位于部署 state_directory 下的 automatic.json，详细阶段与命令日志位于相同的私有状态目录。设置 RunAtLoad 和 900 秒 StartInterval；Mac 登录后执行一次，之后按间隔执行。任务活动时如出现 Workbench 执行中的 Codex、尚未完成的工作记录或仓库本地修改，部署会延后，不会终止工作。

macOS 与 Windows 共用 scripts/deploy-windows.mjs 和 scripts/auto-deploy-windows.mjs 的部署协议；脚本保留原 Windows 文件名，以兼容已有 ROG、Legion 自动更新任务。通过各台主机的独立配置区分运行环境，无须复制仓库或维护不同的公共代码分支。

## 检查项

部署结束后，应分别核实三个主机的 origin、main、HEAD 提交、活动版本指针和实际运行的服务端版本。Git 提交一致只说明源代码版本相同；本机安装成功及隧道重启还需要查看各自自动更新结果。Masked 首次接入需要确认服务端真实的源码安装目录和原始隧道启动方式，再启用版本选择器；不要把注册的 workspace 项目目录误当成服务端源码目录。
