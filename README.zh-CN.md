# chatgpt-local-workbench

中文使用说明统一维护在 [README.md](README.md)，包括用途、部署和权限边界。此文件保留原有中文文档入口，英文版本见 [README.en.md](README.en.md)。

普通长命令可通过 `start_host_process` 执行，无需 Codex／DSH，并复用任务查询、等待和中断接口；示例及运行规则见[本机进程与 agent 任务](docs/native-processes.zh-CN.md)。

完整接口清单、命名取舍及模块边界见[公共接口架构审计](docs/api-architecture-audit.zh-CN.md)。启动回执丢失时可先用 `list_tasks` 查找保留的任务标识，再检查状态，避免重复启动。
