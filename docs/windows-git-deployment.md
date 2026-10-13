# Windows Git 更新部署

`scripts/deploy-windows.ps1` 是 Windows PowerShell 5.1/PowerShell 7 入口，`scripts/deploy-windows.mjs` 使用 Node.js 内置模块执行部署。两台电脑各自维护一个 `main` 检出目录、私有配置和部署状态，各自从 `origin/main` 获取提交。脚本每次只操作配置所指向的本机隧道，不联系另一台电脑。

需要 Node.js 22 及以上、npm、Git，以及已经能够启动的本机 MCP 隧道。使用隧道现有的 Windows 账户运行，以沿用该账户的 Git 凭据及运行环境。脚本不安装服务，也不创建或修改 Windows 计划任务；服务启动由私有配置中的现有入口完成。

## 每台电脑的私有配置

将配置保存在源码目录之外，例如 `E:\BridgePrivate\deploy.json`。以下示例中的路径、别名和隧道 ID 均须替换为该电脑已有的值；第二台电脑使用自己的配置，不复制第一台电脑的凭据、隧道 ID 或会话目录。

```json
{
  "version": 1,
  "repository": "E:/Projects/chatgpt-local-workbench",
  "state_directory": "E:/BridgePrivate/deployment-state",
  "npm_cli": "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js",
  "work_registries": [
    "E:/BridgePrivate/workspaces.json.work-items.json"
  ],
  "protected_files": [
    "E:/BridgePrivate/workspaces.json",
    "E:/BridgePrivate/workspaces.json.host-policy.json",
    "E:/BridgePrivate/profiles/engineering-bridge.yaml",
    "E:/BridgePrivate/start-bridge-for-tunnel.cjs"
  ],
  "tunnel": {
    "id": "EXISTING_TUNNEL_ID_ON_THIS_COMPUTER",
    "status": {
      "executable": "E:/Tools/tunnel-client.exe",
      "args": ["runtimes", "status", "engineering-bridge", "--json"]
    },
    "stop": {
      "executable": "E:/Tools/tunnel-client.exe",
      "args": ["runtimes", "stop", "engineering-bridge", "--json"]
    },
    "start": {
      "executable": "C:/Program Files/nodejs/node.exe",
      "args": ["E:/BridgePrivate/start-existing-tunnel.cjs"]
    },
    "environment": {
      "TUNNEL_CLIENT_STATE_DIR": "E:/BridgePrivate/tunnel-state"
    }
  },
  "command_timeout_seconds": 1200,
  "health_timeout_seconds": 90
}
```

示例 JSON 使用 Windows 支持的正斜杠路径，也可使用经过 JSON 转义的双反斜杠路径。所有路径均为绝对路径；配置文件、任务记录及受保护文件必须已存在。`state_directory` 使用专用目录，脚本负责创建，其内容不得与源码或私有配置重叠。

| 字段 | 设置方法 |
| --- | --- |
| `repository` | 本机 Git 工作树根目录，分支为 `main`，上游为 `origin/main`。 |
| `state_directory` | 本机独立的日志和部署进度目录，不在两台电脑之间同步。 |
| `work_registries` | 列出所有使用该检出目录的 Bridge 实例的 `<workspace-config>.work-items.json`。Bridge 正常启动后会创建此文件。 |
| `protected_files` | 列出需要保留内容的已有隧道配置及 Bridge 配置、启动文件。部署配置本身自动加入校验。可同时列入凭据文件；校验仅记录散列值。 |
| `tunnel.id` | 从本机已有隧道的状态结果读取，沿用原 ID。 |
| `tunnel.status/stop/start` | 本机已有管理方式的三个命令，使用实际可执行文件及独立的参数数组。 |
| `tunnel.environment` | 仅传给上述三个命令的本机环境设置，包括原状态目录、代理或凭据引用所需变量；其余环境继承当前进程。 |
| `npm_cli` | 已安装 npm 的 `bin/npm-cli.js`。省略时按当前 Node 可执行文件旁的 `node_modules/npm/bin/npm-cli.js` 查找。 |
| `git_executable` | 可选的 Git 可执行文件绝对路径；省略时使用 `PATH` 中的 `git`。 |

命令通过参数数组直接执行，路径中的空格不需要额外嵌入引号。PowerShell 启动脚本应将 `executable` 设为 `powershell.exe` 的绝对路径，并用 `args` 传入 `-NoProfile`、`-NonInteractive`、`-File` 和脚本绝对路径。长期文件可保存在 E 盘，示例中 C 盘路径仅引用已有 Node 安装。

### 隧道命令的约定

`status` 是只读命令，其标准输出必须是一个 JSON 对象，包含 `tunnel_id`、布尔字段 `process_running`、`healthy`、`ready`，运行时还需包含正整数 `process.pid` 或 `pid`。已有 `tunnel-client runtimes status <alias> --json` 满足这一结构。状态读取失败或 ID 不匹配时，部署停止。

`stop` 应结束该隧道及其管理的旧 Bridge 进程，并在操作完成后退出。脚本随后读取状态，确认旧隧道已经停止。`start` 应沿用已有 ID、配置和原生会话目录，通过原有管理方式启动同一个隧道，并在启动请求完成后退出。它应使用已有凭据引用，不创建远端隧道、不改写配置、不清理会话数据。示例中的 `start-existing-tunnel.cjs` 表示机器上已有的启动入口，需替换为实际路径和参数。

某些 `runtimes connect` 用法会生成或改写 profile；只有确认现有启动入口保留配置内容后，才将其用作 `start`。脚本在调用前后核对受保护文件的 SHA-256，以及状态中的原隧道 ID。启动成功还要求新进程 PID 与部署前不同，并且 `healthy` 和 `ready` 均为 `true`。

## 命令

在每台电脑各自的仓库中执行检查：

```powershell
.\scripts\deploy-windows.ps1 -Config E:\BridgePrivate\deploy.json -Mode Check
```

`Check` 是默认模式。它检查本机条件并 fetch `origin/main`，更新远端跟踪引用和仓库外日志，但不移动本地 `main`，不安装依赖或调用启停命令。结果中的 `deployment_needed` 表示是否有尚未完成的本机部署；第一次使用脚本时，即使 Git 提交已相同，也仍需执行一次完整部署来建立成功记录。

在本机 Bridge 任务完成后的维护窗口执行部署：

```powershell
.\scripts\deploy-windows.ps1 -Config E:\BridgePrivate\deploy.json -Mode Apply
```

也可直接使用 Node，无需改变 PowerShell 执行策略：

```powershell
node .\scripts\deploy-windows.mjs check --config E:\BridgePrivate\deploy.json
node .\scripts\deploy-windows.mjs apply --config E:\BridgePrivate\deploy.json
```

两台电脑可以在不同时间执行相同语法，各自取得当时的 `origin/main`。在一台电脑推送代码不代表另一台电脑已经部署，也不会触发其重启。

## 执行过程与失败处理

脚本先检查工作树和暂存区，未跟踪文件也计入检查；合并或变基等进行中的 Git 操作会阻止部署。`main` 必须跟踪 `origin/main`，并且当前提交是本次 fetch 所得提交的祖先。更新使用固定提交的 `git merge --ff-only`，不会 stash、本地提交或重置分支。领先或分叉的本地提交需要先由维护者处理。

任务记录采用 Bridge 现有 `.lock` 协议。部署取得所有配置中任务记录的锁后再次检查空闲状态，并将锁保持到验证完成且旧隧道已经停止。Bridge 会在保存执行记录之后才启动执行器，因此锁定期间的新执行请求会暂时失败，调用方可在维护完成后重试。`queued` 或 `running` 记录均会延后部署，包括所有者缺失或已经退出的记录；脚本保留这些记录，待 Bridge 或维护者核实任务状态。

锁覆盖已配置的 Bridge 执行记录，不管理其他 Codex 客户端的活动，也不锁定直接主机命令、原生历史操作或独立的隧道看护程序。维护期间应暂停从这些入口发起操作；若已有看护程序可能主动重建服务，应让它与部署维护窗口协同。验证期间发现隧道 PID 变化时，本次部署结束并要求重试。

快进成功后依次执行：

```text
npm ci
npm run typecheck
npm test
npm run build
```

所有命令成功后，脚本再次核对 Git 提交及工作树，并检查任务记录和受保护文件的内容，随后才调用 `stop`。确认旧隧道停止后释放任务记录锁，让新的 Bridge 能够正常读取和保存原记录，再调用 `start` 并等待健康检查。

Git、依赖安装或验证失败时，脚本不调用隧道启停命令。已经完成的快进会保留，`node_modules` 和 `dist` 也可能已有部分更新；脚本不回退代码或替换私有状态。因此，正在运行的进程继续运行，但后续新进程是否能启动仍取决于修复后的依赖和构建结果。修复问题后重新执行相同 `Apply` 命令，它会重新运行全部 npm 步骤，直到新提交通过验证并完成重启。

隧道启动或健康检查失败时，日志保留失败阶段，不标记部署成功，也不自动循环重启。若启动实际已成功但返回信息丢失，下一次 `Apply` 会验证同一提交、相同构建内容及受保护文件，并确认原 ID 的新进程健康，然后补记成功而不再次重启。已成功部署的提交在构建内容相同且隧道健康时直接返回 `up-to-date`。

脚本不读写 Codex 原生会话目录，不删除工作记录或结果文件。重启后，已有 `work_id` 与原生 thread UUID 继续由原配置和会话目录提供；正在执行的任务需先完成，进程重启本身不恢复尚未完成的执行。

## 日志与锁恢复

`state_directory` 中的 `deployment.json` 记录目标提交、成功部署的提交和当前阶段。每次调用另存一份 `.jsonl` 事件日志及 `.commands.log` 命令输出，控制台仅显示阶段信息及结果。命令日志最多保留每个命令前 20 MiB 输出；凭据及工具诊断可能出现在命令输出中，因此此目录应沿用仅供运行账户访问的 Windows 文件权限。旧日志可按本机保留策略清理，成功状态文件应保留。

退出码 `0` 表示检查或部署成功，`2` 表示条件暂不满足，例如任务占用、工作树有改动或锁被占用，`1` 表示命令、配置或验证失败。普通失败和 Ctrl+C 会等待本次创建的子进程退出后释放锁；超时或取消时，Windows 使用该子进程的 PID 终止其进程树，不按进程名称结束服务。

异常断电或强制结束进程可能留下锁。脚本不会按锁文件年龄自动删除锁，以免上一轮的 npm 子进程仍在修改目录。事件日志包含每个命令的 PID；核实锁中进程及日志中的子进程均已结束后，只移除本次部署遗留的 `<git-common-dir>/bridge-deploy.lock`、`<state_directory>/deployment.lock` 和各任务记录旁的 `.lock`，随后重新执行 `Apply`。保留 `deployment.json` 及原有工作、隧道和会话数据。修改部署配置后使用新的专用状态目录，以明确区分不同配置的部署记录。

## 测试

```powershell
node --test tests/deployment/deploy-windows.test.mjs
npm run typecheck
npm test
npm run build
```

独立测试使用临时裸 Git 远端及两份真实检出目录，npm 和隧道命令均为临时模拟程序，覆盖按电脑独立更新、失败重试及服务状态检查。`tests/unit/deployment.test.ts` 将它们接入现有 `npm test` 和 Windows/Linux CI，并验证部署锁能阻止真实 `WorkService` 启动执行器。测试不会调用现有隧道，也不会创建 Windows 计划任务；临时文件位于 `codex-generated/deployment-tests` 下，并在每个测试结束后清理。
