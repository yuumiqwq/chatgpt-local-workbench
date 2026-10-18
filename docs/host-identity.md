# 多电脑部署身份

每个实例可在自己的工作区配置旁保存私人文件 `workspaces.json.identity.json`，填写 `hostname`、`display_name` 和完整的中文 `instructions`。启动时服务先通过 `node:os.hostname()` 读取真实主机名，再与配置值进行不区分大小写的比较；名称不符时以 `HOST_IDENTITY_HOSTNAME_MISMATCH` 退出，工作区迁移与 MCP 启动均不会执行。文件存在但格式错误或读取失败时也会退出。

未提供该文件时，原有服务说明保持不变，`host_capabilities` 增加实际 `hostname`，不返回 `display_name`。配置有效时，`host_capabilities` 还返回经主机名校验的 `display_name`；总体 instructions 保留原有长任务、OpenCLI、MinerU 说明及已启用的手机模块说明，末尾追加当前实例的名称、真实主机名、主机工具执行位置和原文 `instructions`。服务名仍为 `engineering-bridge`，工具名称、参数和既有路径权限保持不变。

## ROG Workbench

仅在主机 `LAPTOP-1189PH9Q` 的私人配置目录使用以下内容：

```json
{
  "hostname": "LAPTOP-1189PH9Q",
  "display_name": "ROG Workbench",
  "instructions": "连接用户的华硕 ROG 幻 14 Air，型号 ROG Zephyrus G14 GA403WP，主机名 LAPTOP-1189PH9Q。\n这是当前 ChatGPT 账号默认的本机控制插件。当需要调用本机、操作自己的电脑，或未明确指定其他目标设备时，优先使用本插件。\n支持本机文件读写、命令执行、项目管理及 Codex 任务管理。"
}
```

## Masked Workbench

以下为未来部署示例，仅保存到 `FLAWLESS` 上对应实例的私人配置目录：

```json
{
  "hostname": "FLAWLESS",
  "display_name": "Masked Workbench",
  "instructions": "连接主机名为 FLAWLESS 的独立 Windows 电脑，其具体硬件型号是未知的。\n仅当用户明确要求调用 Masked Workbench 时才使用本插件。\n支持该电脑上的文件读写、命令执行、项目管理及 Codex 任务管理。"
}
```

## Legion Workbench

以下为未来部署示例，仅保存到 `LAPTOP-NHHRR3GO` 上对应实例的私人配置目录；手机能力另外按照 [Legion 部署文档](phone-legion-deployment.md) 配置。

```json
{
  "hostname": "LAPTOP-NHHRR3GO",
  "display_name": "Legion Workbench",
  "instructions": "连接用户的家用服务器，设备为联想 Legion R7000 2020，型号 82B6，主机名 LAPTOP-NHHRR3GO。\n专用于家用服务器管理及 HONOR 80 云手机控制。当需要调试或配置家用服务器、联想拯救者或连接在服务器上的荣耀 80 时，优先使用本插件。\n支持文件读写、命令执行、项目管理及 Codex 任务管理，并通过 USB ADB 提供荣耀 80 的应用操作、截图和触屏控制等功能。所有主机操作均在联想拯救者上执行，手机操作则由拯救者转发到连接的荣耀 80。"
}
```

身份配置随 MCP 进程启动读取，`reload_workspace_config` 不会重载此文件。部署切换前核对目标主机、运行代码路径及工作区配置路径，并检查现有任务状态，再安排该实例的后端重启。保存 sidecar 和推送源码不会切换当前 runtime，也不会创建或修改 tunnel、ChatGPT 插件；ROG 上只保存 ROG 配置，Masked 与 Legion 示例留待各自部署时使用。
