# 本机进程与 agent 任务

| 用途 | 接口 | 生命周期 |
| --- | --- | --- |
| 查询版本、Git 状态等短命令 | `run_host_command(executable, args, cwd, timeout_seconds?)` | 同步返回，默认 25 秒，最多 45 秒，不创建任务 ID。 |
| 长时间构建、文档转换、训练或脚本执行 | `start_host_process(executable, args, cwd, timeout_seconds?)` | 直接启动操作系统进程，返回 `task_id`，无需 Codex／DSH。 |
| 需要 agent 推理或编辑的一次性工作 | `run_temp(instruction, work_id/workspace_id/cwd, executor?)` | 一次 Codex 或 DSH 执行，返回 `task_id`。 |
| 需要保留对话历史的持续工作 | `open_work`，随后调用 `continue_work(work_id, instruction)` | 工作使用 `work_id`，每次 Codex 执行各有一个 `task_id`。 |
| 立即查看执行状态和输出 | `task_result(task_id)` | 返回运行快照或终态结果。 |
| 等待执行 | `wait_task(task_id, timeout_seconds?)` | 就绪或本次等待超时后返回，不停止执行。 |
| 停止执行 | `control_task(task_id, action: "interrupt")` | 请求终止，随后通过原任务 ID 确认实际退出。 |

新增名称 `start_host_process` 明确表示异步本机进程。现有名称继续保留，`run_temp` 的说明明确其临时 agent 用途，`task_result` 已承担任务检查功能，因此不增加重复的 `get_task`。`finish_work` 用于记录持续 agent 工作是否完成，`manage_work` 用于管理对应历史；两者均不管理本机进程。全部现行接口见[工具表](tools.md)。

## 使用示例

先查看 `host_capabilities`，并确认连接主机上的实际解释器路径。将下面的示例路径替换后，作为参数传给 `start_host_process`：

```json
{"executable":"E:\\Tools\\Python\\python.exe","args":["E:\\Projects\\report\\render.py","--format","pdf"],"cwd":"E:\\Projects\\report","timeout_seconds":7200}
```

保存返回的 `task_id`，用 `wait_task` 配合 `timeout_seconds: 25` 等待。需要立即查看输出时使用 `task_result`，需要停止时使用 `control_task` 的 `interrupt` 操作。查询 `python --version` 可使用同步主机命令；需要分析转换脚本错误时可调用 `run_temp`。直接执行本机命令不会启动模型。

## 状态、输出与保留

异步执行共用 `queued → running → completed/failed` 状态和结果保留机制，`kind` 区分 `process` 与 `agent`。进程数据位于独立的 `process` 字段，包括可执行文件、工作目录、PID、时间戳、标准输出和标准错误，以及退出码、信号和停止原因。进程没有 agent 执行器、模型权限模式、对话 ID 或工作关联；参数数组不写入任务登记文件或审计日志。

观察到零退出码且没有停止请求时，状态为 `completed`。启动失败、非零退出、中断和运行期限到达均使用 `failed` 并提供相应错误。`ready` 表示执行进入终态，不代表生成内容已验收。`exit_code: null` 可能表示信号退出或结果未知，不表示成功；在实际退出前接受的中断请求仍记为中断，已观察到的退出结果不会被后续中断改写。

标准输出与标准错误合计保留最初 65,536 个原始字节，超过后继续读取并丢弃，同时设置 `truncated`。返回内容按 UTF-8 解码，不提供二进制传输或两个流之间的统一顺序。运行快照约每 500 毫秒更新，终态结果包含最后捕获的输出。完整日志和训练检查点由程序自行写入文件。标准输入关闭，不支持交互输入或进程 `steer`。

每个 Bridge 实例最多同时接纳八个本机任务，启动准备也占用名额。此限制不构成整台主机的配额。`work_retention` 同时管理进程和 agent 结果，默认保留最近 100 个终态任务，运行任务不参与清理；已存结果可跨重启读取，程序不会自动恢复或重放。

## 等待、取消和重启

省略执行期限时允许持续运行；显式 `timeout_seconds` 范围为 1–604800 秒，从操作系统进程启动开始计时。等待超时、取消等待或结束聊天不会停止任务，任务依赖所属 Bridge 实例继续存活。启动请求在调度前取消时不执行程序，调度后取消响应不会终止程序；响应丢失时需要检查已有记录和进程，避免直接重发启动请求。启动回执仅确认任务已调度，实际启动失败通过任务结果报告。

中断工具立即提交强制终止请求，Windows 异步调用 `taskkill /T /F`，失败时尝试终止直接子进程；POSIX 使用独立进程组和 `SIGKILL`。终止失败时继续监控和重试，并报告 `termination_error`，不提前记录退出。直接子进程退出后最多继续读取管道 250 毫秒，管道仍未关闭时记录截断。POSIX 在父进程自然退出时也尝试清理进程组；Windows 的进程树清理依赖父进程仍然存活，两类系统中主动脱离或重新归属的后代进程都可能逃离清理范围。这里没有 Windows Job Object 或操作系统沙箱，程序应自行管理并等待工作进程退出。

每个本机任务由独立 Node 监护进程管理。Bridge 正常关闭 STDIO 或退出时请求清理，Bridge 突然终止时由 IPC 断开触发监护进程清理。若最终结果未能写入，重新读取时将已失去所属 Bridge 的运行任务标记为失败，保留最后输出并明确退出结果未知。恢复过程不使用磁盘中的旧 PID 杀进程，以免 PID 复用影响其他工作。监护进程本身被强制终止、操作系统无法终止目标或断电时，清理和结果保存可能无法完成，需要检查文件与系统进程后再决定是否重新启动。控制请求须到达任务所属 Bridge，其他实例可以读取已保存的状态。

## 权限与更新

复用现有 `enabled`、`commands_enabled` 和 `command_roots` 策略，要求明确且实际存在的授权工作目录。可执行文件使用绝对路径，参数通过数组传入，设置 `shell: false` 并隐藏窗口，不自动提权；显式调用解释器仍可执行任意代码。进程继承 Bridge 环境和当前系统账户权限，工作目录策略只限制起始目录，不限制后续文件或网络访问。远程认证由部署服务提供。启用手机维护互斥时，整个本机进程执行期间持有维护锁，因此对应手机操作需等待任务结束。启动审计记录只描述调度，运行结果保存在任务记录中。

完成构建和测试后，等待现有 agent 与进程任务结束，再协调重启实际服务，并保留私有配置、任务登记文件和结果目录。刷新 MCP 工具元数据后即可发现新入口。共享登记文件的所有 Bridge 实例应在创建进程任务前统一升级；新版继续读取原有 agent 记录，旧版无法读取新增的进程记录，因此不应直接对含进程记录的登记文件回退旧程序。Git 推送本身不更新运行中的服务。
