# Lenovo Legion 手机模块部署与验收

本模块在完整 Local Workbench 的同一个 MCP stdio 服务中增加九个工具，原有 host、workspace、Codex、DSH、Task 和持久 Work 功能保留。没有手机配置，或配置为 `{"enabled":false}` 时，工具列表与宿主说明维持原样。本次开发与 fake device 测试发生在 ROG 的隔离工作树；ROG 不是联想拯救者，当前没有 Lenovo 部署或真实手机控制的验收记录。

目标主机为 Lenovo Legion R7000 2020 / 82B6，hostname 为 `LAPTOP-NHHRR3GO`。目标手机为 HONOR 80 / ANN-AN00，固定 ADB serial 为 `AYCVVB2B09005827`，预期 Android 15 / MagicOS 9，原始显示尺寸为 1080×2400。这些是部署目标资料，运行状态以现场探测为准。

## 一次性准备

在 Lenovo 本机使用明确选定的 Windows 运行账户完成安装。采用现有完整仓库的独立 checkout，例如 `E:\LocalWorkbench`，保留并核对该实例的全部 workspace、host-policy、Work 状态和 Codex/DSH 安装。执行 `npm ci`、`npm run typecheck`、`npm test` 和 `npm run build`。全套测试使用模拟设备，不连接真实手机。不要在正在服务的 checkout 上执行会删除 dist 的构建；安装或升级可使用独立 checkout，并在该 Lenovo 实例的维护窗口切换。

ADB 位于真实用户配置目录下的 `CloudPhoneServer\scrcpy-win64-v5.0.1\adb.exe`。先在资源管理器中核实完整路径，随后在同一个运行账户下检查文件与版本，配置中填写经核实的绝对路径。服务账户的 `%LOCALAPPDATA%` 可能指向另一用户，示例中的占位路径必须替换。模块不安装 ADB、不选择 PATH 中的 adb，也不复制 adbkey。授权必须通过该运行账户启动的 ADB 和手机上的授权提示实测；`device` 仅说明 ADB 通道可用，首次解锁仍可能为 unknown。

创建专用私有目录，例如 `E:\LocalWorkbenchPrivate\phone-AYCVVB2B09005827`，用 Windows 文件 ACL 限制为指定运行账户、SYSTEM 与本机管理员可访问。所有控制此手机的 MCP stdio 进程必须使用**同一个本地 NTFS state_dir**；不要为不同 tunnel channel、配置副本、服务账户分别创建目录，不使用网络盘或同步盘。该目录既保存租约，也保存互斥锁与请求收据。运行账户具有维护权限，具备修改配置或状态目录的账户可以绕过协议约束。

将 `config/phone.example.json` 复制为 Lenovo 私有工作区配置旁的 `workspaces.json.phone.json`，核实 hostname、adb_path、state_dir 后才将 enabled 设为 true。serial 固定为目标手机，不从调用参数接受其他设备。保留 ime_enabled=false，直到输入法完成本机编译、安装和现场测试。ROG 不添加启用配置，也不更改其现有配置、服务或 tunnel。

既有守护器的路径是 `C:\Users\常可依\Documents\Codex\2026-10-17\workbench-plugin-dev-6acbd4feb9708191ad19dd29cd9b8a0e-created-by\outputs\CloudPhoneServer\Phone-Host.ps1`。该守护器每 5 秒管理 scrcpy，每 30 秒设置 stay awake。本模块不启动第二个 scrcpy，不修改、终止或重启该脚本，也不修改 stay-awake 标志。ADB 写入与按需截图均独立于 scrcpy。

## 单一 Secure MCP Tunnel

按 [OpenAI Secure MCP Tunnel 官方文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 配置 Lenovo 实例的一条 stdio command：绝对 node.exe 路径、该实例 `dist/src/mcp-stdio.js` 的绝对路径、该实例 `workspaces.json` 的绝对路径。使用一个 tunnel_id，全部原有工具与手机工具经同一 MCP command 提供，不另建手机 tunnel。

在 Lenovo 本机先运行 `tunnel-client help quickstart`，按当前 CLI 帮助建立或复用该实例的 stdio profile，使用 `tunnel-client doctor --profile <Lenovo profile> --explain` 验证配置，再由该实例既有启动方式运行 `tunnel-client run --profile <Lenovo profile>`。带空格路径的 command 引用方式需通过 doctor 和本机工具发现实测。不要操作 ROG profile。运行密钥通过本机安全输入和环境引用提供，不放入仓库、命令参数、报告或截图；无需 SSH，也无需自动 Windows 登录。

官方单次序列化请求或响应上限为 10 MiB，总期限为 120 秒。模块每个 ADB 子进程最多 8 秒、输出最多 16 MiB，不自动重试；单次动作的最长 ADB 链不超过 64 秒，两个图像转换各最多 3 秒，且不排队等待锁。排队时间仍消耗官方期限，系统调度和磁盘异常也可能导致调用超时。此时保留 request_id 查询，不以新 ID 重放。

图像最大边为 1280，PNG 字节最多 3 MiB，UI JSON 字节最多 512 KiB，完整响应留有低于 10 MiB 的余量；超出预算返回错误。`width/height` 为原始 PNG 尺寸，`rendered.width/height` 为返回图像尺寸。输入始终使用原始物理像素，例如原始 1080×2400 的图像缩至 576×1280 后，图像中坐标必须按各轴比例换回原始坐标。旋转后以新 frame 为准，不使用上次宽高。每次观察只采一张新的 PNG，前后核对包名、物理尺寸和旋转，物理尺寸与原始 PNG 也须相符。Android 没有为这些命令提供跨截图/XML 的原子快照，UI dump 与截图之间存在短暂竞态，`capture_atomic=false` 明示这一事实。动画不再因两次截图内容不同而阻止观察；输入前的像素变化校验仍可能拒绝在动画页面上执行动作。配置了非原始 wm size 的显示暂不接受输入或观察，以避免坐标解释错误。

## 无手机写动作的现场验收

由实际运行账户在 Lenovo checkout 内执行：

```powershell
node scripts/legion-phone-check.mjs E:\LocalWorkbenchPrivate\workspaces.json
node scripts/legion-phone-check.mjs E:\LocalWorkbenchPrivate\workspaces.json --ui
```

脚本核对 hostname、serial、原有代表工具与九个新增工具，执行状态、按需截图和应用列表探测。它不点击、不启动应用、不唤醒、不切换输入法，也不管理任何守护器；会启动并关闭一个短期 MCP 子进程，并更新本地观察元数据。ADB 与 uiautomator 本身仍会产生临时进程。脚本不保存截图或 XML，只输出不含屏幕内容的摘要；在 ROG 上直接拒绝运行。当前 Workbench 配置应已完成旧字段迁移，避免新建 stdio 进程触发原有配置迁移逻辑。

随后通过同一 Lenovo tunnel 调用 `server_status`、`list_workspaces` 和 `phone_observe`，核实真实 tunnel 连通性。上述本地脚本通过仅证明本地 stdio 通路；现场报告应分别记录本地、tunnel、设备读操作和设备写操作的证据，不将其中一种替代其他种类。

## 输入法部署与最小写入验收

开源轻量输入法位于 `android/workbench-ime`，沿用仓库 MIT 许可，没有网络权限、不记录输入文本。构建需要 JDK 17、Android SDK Platform 35 与 Gradle 8.9；在已配置 Android 构建环境的机器执行 `gradle -p android/workbench-ime assembleDebug`。项目未捆绑二进制 Gradle wrapper、SDK、签名私钥或预编译 APK。构建产物在 app/build/outputs/apk/debug；长期使用应由管理员用自己的密钥签名并保管密钥。当前开发机没有 Java/Gradle 工具链，APK 构建和 Android 行为尚未验证。

仅在 Lenovo 上，用经核实的 adb.exe 及固定 `-s AYCVVB2B09005827` 安装经过审核的 APK，记录原来的 `settings get secure default_input_method` 值。通过手机设置启用并选择 `org.workbench.ime/.WorkbenchIme`，或在明确的本机维护阶段使用 `ime enable` 与 `ime set` 完成相同操作。之后将 ime_enabled 设为 true，并在维护窗口重新启动 Lenovo 该实例的 stdio 进程。不要启动或重启 Phone-Host。

在手机上手动打开无敏感信息的空白备忘录，由用户明确授权测试输入。依次 acquire、observe、input，使用随机 request_id，测试包含中文、换行与 emoji 的 append/replace。append 定义为在字段末尾追加，replace 定义为替换整个字段；输入法要求编辑器支持完整文本提取与选区，否则拒绝并返回不确定结果供观察。核对文本实际落入目标字段后释放租约，并恢复原输入法。不要在支付、发消息、授权或密码输入界面验收。IME 的成功回执表示 InputConnection 接受提交，实际显示仍须核对。

输入广播使用 UTF-8 Base64，由动态接收器要求调用方具有 Android `DUMP` 权限；普通应用无此权限，ADB shell 具备相应维护能力。该方式无需 Root，详见 [Android registerReceiver 权限语义](https://developer.android.com/reference/android/content/Context) 与 [InputConnection API](https://developer.android.com/reference/android/view/inputmethod/InputConnection)。Base64 不等于加密，有 OS 进程查看权限的维护人员可看到命令参数。输入文本不写入 Workbench 请求记录或故障日志。

## 暂停、崩溃恢复与退出

本机管理员可随时执行以下暂停命令；无需 MCP 租约，它立即写入暂停标记并轮换租约 epoch，禁止后续写动作。已经发送给 Android 的动作可能完成，无法撤回。

```powershell
node dist/src/phone/admin.js E:\LocalWorkbenchPrivate\workspaces.json.phone.json pause
node dist/src/phone/admin.js E:\LocalWorkbenchPrivate\workspaces.json.phone.json resume
```

正常释放是幂等操作。暂停后的 resume 会再次轮换 epoch，旧 lease_id 不会重新有效。遇到 `PHONE_BUSY_OR_ABANDONED_LOCK` 时，先暂停，再确认 Lenovo 该实例所有手机模块 stdio 进程已经停止；不要停止共享 ADB、scrcpy、Phone-Host 或 ROG 服务。记录锁目录中的 PID，并核对进程。管理员随后才能执行：

```powershell
node dist/src/phone/admin.js E:\LocalWorkbenchPrivate\workspaces.json.phone.json recover-lock --all-servers-stopped
```

恢复命令检查锁 PID，进程存活、权限不足或 PID 被重用时均拒绝接管。mkdir 后、PID 写入前崩溃造成的无 PID 锁，仅在管理员明确确认所有相关 stdio 已停止时移除。锁不会因为时间过长而自动失效，从而避免 Windows 睡眠、暂停或慢磁盘产生两个写入者。恢复后保持暂停，保留全部 request 收据；核对 pending 操作的设备结果后再 resume。不要删除状态目录来“修复”操作，否则会丢失防重放记录。

物理熄屏目前不提供实现：`physical_off` 返回 `unsupported_unverified`，不会发送 POWER 键。`wake` 使用 WAKEUP，它不承诺解锁。POWER 会改变交互/锁屏状态，与 scrcpy 的面板关闭语义不同；未来任何 scrcpy 面板控制必须先验证与既有 Phone-Host 的单一所有权协调。USB 断开、未授权和首次解锁不明时，按现场状态引导用户连接、授权或解锁。恢复工具不重启手机、不清空密钥、不重启共享 ADB server。

## 已覆盖与待验证

fake device 测试覆盖 MCP schema 与调用、共享租约、持久去重、不确定结果、窗口/旋转/像素变化、USB 状态、图像尺寸与预算，以及真实 Windows 子进程被终止后的锁恢复。完整仓库测试用于核对 host、workspace 和任务功能回归。

Lenovo 待验收项包括运行账户 adbkey 授权、MagicOS dumpsys 格式、uiautomator `/dev/tty` 可用性、保护窗口行为、中文输入法 APK 构建安装与编辑器兼容性，以及同一 tunnel 的真实请求响应。FLAG_SECURE、首次解锁和物理面板状态无法可靠核实时返回 unknown，不根据黑屏图像推断。节点定位输入、物理熄屏、自管理投屏以及自动 USB 恢复属于后续扩展；当前不承诺这些能力。
