# Lenovo Legion 手机模块部署与验收

本模块在完整 Local Workbench 的同一个 MCP stdio 服务中增加十一个工具，原有 host、workspace、Codex、DSH、Task 和持久 Work 功能保留。没有手机配置，或配置为 `{"enabled":false}` 时，工具列表与宿主说明维持原样。初始开发使用模拟设备，后续已在联想拯救者与荣耀 80 上部署；具体版本的现场结果见同目录验收文档。

目标主机为 Lenovo Legion R7000 2020 / 82B6，hostname 为 `LAPTOP-NHHRR3GO`。目标手机为 HONOR 80 / ANN-AN00，固定 ADB serial 为 `AYCVVB2B09005827`，预期 Android 15 / MagicOS 9，原始显示尺寸为 1080×2400。这些是部署目标资料，运行状态以现场探测为准。

## 一次性准备

在 Lenovo 本机使用明确选定的 Windows 运行账户完成安装。采用现有完整仓库的独立 checkout，例如 `E:\LocalWorkbench`，保留并核对该实例的全部 workspace、host-policy、Work 状态和 Codex/DSH 安装。执行 `npm ci`、`npm run typecheck`、`npm test` 和 `npm run build`。全套测试使用模拟设备，不连接真实手机。不要在正在服务的 checkout 上执行会删除 dist 的构建；安装或升级可使用独立 checkout，并在该 Lenovo 实例的维护窗口切换。

ADB 位于真实用户配置目录下的 `CloudPhoneServer\scrcpy-win64-v5.0.1\adb.exe`。先在资源管理器中核实完整路径，随后在同一个运行账户下检查文件与版本，配置中填写经核实的绝对路径。服务账户的 `%LOCALAPPDATA%` 可能指向另一用户，示例中的占位路径必须替换。模块不安装 ADB、不选择 PATH 中的 adb，也不复制 adbkey。授权必须通过该运行账户启动的 ADB 和手机上的授权提示实测；`device` 仅说明 ADB 通道可用，首次解锁仍可能为 unknown。

创建专用私有目录，例如 `E:\LocalWorkbenchPrivate\phone-AYCVVB2B09005827`，用 Windows 文件 ACL 限制为指定运行账户、SYSTEM 与本机管理员可访问。所有控制此手机的 MCP stdio 进程必须使用**同一个本地 NTFS state_dir**；不要为不同 tunnel channel、配置副本、服务账户分别创建目录，不使用网络盘或同步盘。该目录既保存租约，也保存互斥锁与请求收据。运行账户具有维护权限，具备修改配置或状态目录的账户可以绕过协议约束。

将 `config/phone.example.json` 复制为 Lenovo 私有工作区配置旁的 `workspaces.json.phone.json`，核实 hostname、adb_path、state_dir 后才将 enabled 设为 true。serial 固定为目标手机，不从调用参数接受其他设备。保留 ime_enabled=false，直到输入法完成本机编译、安装和现场测试。ROG 不添加启用配置，也不更改其现有配置、服务或 tunnel。

既有守护器的路径是 `C:\Users\常可依\Documents\Codex\2026-10-17\workbench-plugin-dev-6acbd4feb9708191ad19dd29cd9b8a0e-created-by\outputs\CloudPhoneServer\Phone-Host.ps1`。该守护器每 5 秒管理 scrcpy，每 30 秒设置 stay awake。本模块保留该脚本和 stay-awake 标志。配置物理暗屏功能时，可使用短期 scrcpy 控制连接；日常投屏仍由原守护器管理。

## 单一 Secure MCP Tunnel

按 [OpenAI Secure MCP Tunnel 官方文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 配置 Lenovo 实例的一条 stdio command：绝对 node.exe 路径、该实例 `dist/src/mcp-stdio.js` 的绝对路径、该实例 `workspaces.json` 的绝对路径。使用一个 tunnel_id，全部原有工具与手机工具经同一 MCP command 提供，不另建手机 tunnel。

在 Lenovo 本机先运行 `tunnel-client help quickstart`，按当前 CLI 帮助建立或复用该实例的 stdio profile，使用 `tunnel-client doctor --profile <Lenovo profile> --explain` 验证配置，再由该实例既有启动方式运行 `tunnel-client run --profile <Lenovo profile>`。带空格路径的 command 引用方式需通过 doctor 和本机工具发现实测。不要操作 ROG profile。运行密钥通过本机安全输入和环境引用提供，不放入仓库、命令参数、报告或截图；无需 SSH，也无需自动 Windows 登录。

官方单次序列化请求或响应上限为 10 MiB，总期限为 120 秒。模块每个 ADB 子进程最多 8 秒、输出最多 16 MiB，不自动重试；单次动作的最长 ADB 链不超过 64 秒，图像转换最多 3 秒，且不排队等待锁。排队时间仍消耗官方期限，系统调度和磁盘异常也可能导致调用超时。此时保留 request_id 查询，不以新 ID 重放。

图像最大边为 1280，PNG 字节最多 3 MiB，UI JSON 字节最多 512 KiB，完整响应留有低于 10 MiB 的余量；超出预算返回错误。`width/height` 为原始 PNG 尺寸，`rendered.width/height` 为返回图像尺寸。输入始终使用原始物理像素，例如原始 1080×2400 的图像缩至 576×1280 后，图像中坐标必须按各轴比例换回原始坐标。旋转后以新 frame 为准，不使用上次宽高。每次观察只采一张新的 PNG，前后核对包名、物理尺寸和旋转，物理尺寸与原始 PNG 也须相符。Android 没有为这些命令提供跨截图/XML 的原子快照，UI dump 与截图之间存在短暂竞态，`capture_atomic=false` 明示这一事实。观察和输入均不比较截图内容是否变化。配置了非原始 wm size 的显示暂不接受输入或观察，以避免坐标解释错误。

## 无手机写动作的现场验收

版本 `1.7.0-local.12` 使用 `context-only-v4`，移除全部像素、目标区域、手势区域及控件子树和页面锚点对比。坐标动作直接执行，控件动作使用最近观察记录的坐标，输入前无需重复截图或读取控件树。仍核对观察时效、窗口、应用、尺寸和旋转；文字输入确认活动输入连接，请求收据继续防止重复执行。动作后返回新观察，调用方据此确认结果。连续任务复用同一控制租约，每次成功操作续期，结束或暂停时释放。

版本 `1.7.0-local.8` 的普通滚动会从新读取的控件树中选择包含手势起终点的最内层滚动容器，并调用 Appium `mobile: scrollGesture`；页面未提供唯一容器时沿用坐标触摸手势。`touch.method` 标明执行方式，专用滚动接口还返回驱动报告的 `can_scroll_more`，实际移动情况通过动作后的画面确认。点击和拖动的既有实现保持不变，接口参数无需调整。

版本 `1.7.0-local.9` 为普通滚动加入时长最多 ±8%、专用滚动距离最多 ±3% 的变化，中心值沿用原参数，不增加停顿；坐标回退保留起终点，拖动 `swipe` 保留原指定时长。动作后的 `observation` 默认 `auto`：控件和文字足够时仅返回界面数据，内容稀少、读取失败或存在较大的无描述图像区域时自动截图，结果中的 `observation.mode/reason` 说明本次选择。可指定 `ui` 或 `image`；条件等待超时在自动模式下返回截图。自动判断依据控件树，调用方需要辨认商品图片或发现下一目标缺少描述时，也可以调用 `phone_observe({ui:false,image:true})` 补充画面。

由实际运行账户在 Lenovo checkout 内执行：

```powershell
node scripts/legion-phone-check.mjs E:\LocalWorkbenchPrivate\workspaces.json
node scripts/legion-phone-check.mjs E:\LocalWorkbenchPrivate\workspaces.json --ui
```

脚本核对 hostname、serial、原有代表工具与十一个新增工具，执行状态、按需截图和应用列表探测。它不点击、不启动应用、不唤醒、不切换输入法，也不管理任何守护器；会启动并关闭一个短期 MCP 子进程，并更新本地观察元数据。ADB 与 uiautomator 本身仍会产生临时进程。脚本不保存截图或 XML，只输出不含屏幕内容的摘要；在 ROG 上直接拒绝运行。当前 Workbench 配置应已完成旧字段迁移，避免新建 stdio 进程触发原有配置迁移逻辑。

随后通过同一 Lenovo tunnel 调用 `server_status`、`list_workspaces` 和 `phone_observe`，核实真实 tunnel 连通性。上述本地脚本通过仅证明本地 stdio 通路；现场报告应分别记录本地、tunnel、设备读操作和设备写操作的证据，不将其中一种替代其他种类。

### 控件优先操作（1.7.0-local.5）

优先复用上一次动作返回的界面数据；开始任务或缺少当前页面信息时，调用 `phone_observe({ui:true,image:false})`。从 `ui.elements` 按文字、控件 ID 或描述选择唯一目标，再用最新 `frame_id`、租约及独立请求号调用 `phone_input`，动作为 `{type:"tap_element",element_id:"观察返回的ID"}`。执行时使用这次观察记录的位置，并核对当前窗口和屏幕方向，不再次读取和比较页面内容。自绘页面没有可用控件时，使用截图选择坐标。

版本 `1.7.0-local.13` 增加 `observation:"context"`，供已明确的短操作连续执行。例如选中搜索框后，只读取当前应用及输入连接；`observation.input_ready` 为真时继续输入关键词，最后用 `auto` 或 `image` 查看搜索结果。中间步骤不截图、不读取控件树，也不附加固定等待；输入连接正在建立时，可用 `phone_observe({ui:false,image:false})` 短暂复查。连续操作使用已观察到且布局明确的目标位置，页面跳转或结果异常时再读取新的界面。需要等待页面文字时使用原有 `wait_for`，它与 `context` 分别使用。

多商品购物通常先完成选品，再进入购物车集中核对数量和总额；记录每组规格及已有数量，可以减少中途往返。常用 App 的操作经验只保存实测有效的导航方式，商品库存、价格和按钮位置以当前页面为准。`result.timing` 分别记录观察前耗时、观察耗时和本次服务端总耗时，便于与云端调用及模型决策等待区分。

版本 `1.7.0-local.14` 将窗口与输入连接查询按原有顺序合并到一次 ADB 调用，并让 PNG 编码与末次状态读取并行完成。图像尺寸和压缩质量保持原值；工具说明仅介绍接口用法，应用操作经验暂存于本文。荣耀 80 同页交替测试中，轻量状态、控件及截图返回耗时的中位数分别约为 370、617 和 1481 毫秒，首次调用及网络、模型决策时间另计。

拯救者本机及 SSH 会话使用 `legion_phone` 本地 MCP，启动命令为 Node 运行 `dist/src/phone/mcp-stdio.js`，参数为现有手机配置文件的绝对路径。此入口只注册十一个手机工具，复用已有租约和手机连接，在 Codex 用户配置中登记后供新会话加载。原有完整 Workbench 和隧道继续保留，操作手机优先走本地进程。登记方式见 [OpenAI MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

版本 `1.7.0-local.15` 增加 `phone_sequence`，调用方传入当前 `frame_id` 与 `steps`，本机连续执行最多八个动作，最后返回一次观察及逐步耗时。步骤沿用 `phone_input.action`，可以附加 `wait_for`；文字输入前自动等待输入连接就绪，`input_ready_timeout_ms` 默认 2000。需要给自绘页面留出加载时间时，可设置 `settle_ms`，范围为 0–2000 毫秒，默认不增加等待。控件等待、各次文本等待和末尾等待的配置预算合计最多 30 秒，设备命令耗时另计。

连续步骤由调用方根据当前页面组合，通用执行器负责等待和执行。中间结果通常只有应用与输入连接状态；下一步使用控件 ID 或指定控件条件时会读取界面数据。某步失败或等待超时后返回已完成的步骤和当前状态；重复提交同一请求号只查询已有记录，随后可用新的观察决定下一步。工具不会保存应用专属的购物流程。

文字紧接序列中的点击时，如果输入连接正在切换且文字尚未发送，执行器会在原等待时间内刷新连接后继续。已有执行记录或结果不明的动作不会重新发送；正常就绪的输入不附加等待。

版本 `1.7.0-local.16` 从默认物理显示屏对应的状态块读取窗口和旋转，避免虚拟显示屏的数据混入。荣耀桌面等自定义窗口名称没有组件路径时，程序会读取该窗口明确记录的所属包名；普通应用沿用原查询路径。

版本 `1.7.0-local.17` 的序列步骤可设置 `settle_after_ms`，在本步动作和控件条件完成后等待 0–2000 毫秒，再执行下一步。默认值为零，所有等待仍共用 30 秒的配置预算。存在可读控件时通常使用 `wait_for`，已观察到自绘页面需要更新时也可以设置短暂等待；下一步使用控件 ID 时会在等待后重新读取控件。

手机调用默认返回简要结果，详细步骤与计时自动记录在手机 `state_dir` 下的 `diagnostics/calls.jsonl`。日志记录每次调用的时间和同一连接内的调用间隔，不保存截图、页面文字或输入内容；文件达到 2 MiB 后轮换，保留一份旧文件。`diagnostic.trace_id` 用于定位记录，`diagnostic.recorded` 表示本次日志是否保存成功。排查时可以传入 `response_detail:full` 获取详细结果，正常操作无需另外编写计时脚本。执行耗时不含日志写入及客户端时间，调用间隔包含客户端处理和请求传输。

本机小象搜索实测中，输入回车没有提交搜索，点击页面“搜索”按钮才进入结果列表。搜索框取得输入连接可能略晚于点击，先用轻量读取确认 `input_ready` 再输入；页面搜索后的加载也需要留出时间。本次将选中搜索框、填写关键词和点击搜索连续执行，等待 800 毫秒后只返回结果图，合计约 7 秒，未更改购物车。

动作后返回新的观察供 Agent 核对结果。页面切换造成焦点暂时消失时只重试读取；`completed` 表示动作已发送并取得后续观察，业务结果由实际页面确认。`1.7.0-local.9` 起，动作后的图像按上述 `observation` 规则返回，使用 `wait_for` 时同时返回条件状态。

版本 `1.7.0-local.10` 会避开滚动容器上方的可点击浮层，在可用区域内保持手势方向，必要时缩短距离。使用这一路径时，`touch.avoided_overlay` 为 `true`；整个容器被遮挡时返回 `PHONE_SCROLL_AREA_OCCLUDED`，调用方可观察并处理浮层。`result.scroll_observation` 根据已有的操作前后控件数据报告 `moved`、`no_movement_observed`、`content_changed` 或 `unavailable`，确认移动时同时给出位移，不额外读取截图。`can_scroll_more` 仅表示驱动对继续滚动的判断，实际移动仍以观察结果为准。

### 持续按住并观察（1.7.0-local.19）

需要边拖边观察的滑块可使用 `phone_drag`。以最新 `frame_id` 和起点坐标调用 `phase:start`，保存返回的 `result.drag.id`，随后用同一连接和控制租约调用 `phase:move` 调整位置；移动后默认返回截图，手指继续按住。位置合适时用 `phase:end` 松手，放弃本次手势时用 `phase:cancel` 取消。途中仍可调用 `phone_observe`，普通点击与滚动在本次拖动结束后继续。

该工具通过本机 scrcpy 5.0.1 的独立控制连接发送触摸事件，不打开投屏窗口。子进程在连接断开、租约失效或暂停时取消手势，30 秒没有拖动命令或单次拖动达到 120 秒也会取消；已有 Phone-Host 和 scrcpy 守护程序继续运行。新工具随本机 MCP 服务加载，已运行的旧连接需要重新连接以取得工具列表。

### Appium 手势与条件等待（1.7.0-local.6）

Appium 3 与 UiAutomator2 驱动作为本机后台服务运行，只监听 `127.0.0.1`。手机配置增加 `"appium_url":"http://127.0.0.1:4735"` 后，控件读取使用 UiAutomator2，点击和滑动使用 W3C touch actions；ADB 继续负责 USB 连接、截图、应用启动及输入法广播。现有 MCP 隧道与 Phone-Host 保持原用途，不另开公网 Appium 端口。

控件点击在确认后的目标内部采用少量位置变化，按下持续 80–160 毫秒后抬起。长按保留指定持续时间，滑动在同一次触摸中生成连续移动事件，并逐渐加速、减速。坐标点击保留调用者指定的位置。会话信息存放在私有手机状态目录，多进程复用同一会话；读取发现会话或 instrumentation 已停止时重新建立连接，已发送的手势不会自动重发。

`phone_observe`、`phone_open_app` 和 `phone_input` 接受可选的 `wait_for`。其中 `selector` 可用 `text`、`resource_id`、`description` 或 `class` 精确匹配，`state` 为 `visible`、`enabled` 或 `gone`；`timeout_ms` 默认 10000、最多 30000，`stable_ms` 默认 200。等待检查目标和当前窗口，广告等无关内容变化不影响目标稳定性。结果通过 `result.wait.status` 返回 `matched` 或 `timeout`，超时后的下一步根据新观察决定。`ui.nodes` 同时提供可见的非按钮文字，便于等待加载结果。

拯救者运行环境为 Appium 3.8.0、UiAutomator2 8.7.0、Node 24.19.0、JDK 17 与 Android SDK。启动入口 `D:\StudyServer\config\start-server.ps1` 调用独立 Appium 守护器，手机端安装 `io.appium.uiautomator2.server` 及对应测试包。真机运行不需要 Android 模拟器；doctor 中的 emulator 缺项按此条件记录。安装完成后先执行本机读写验收，再重载 Legion 的 MCP 运行实例。

工具参数或说明更新后，重载服务器，并在 ChatGPT 的对应自定义插件详情中 Refresh，再开启新会话验收。无需新建隧道、变更身份或修改其他电脑的连接。[官方刷新流程](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)。

## 输入法部署与最小写入验收

开源轻量输入法位于 `android/workbench-ime`，沿用仓库 MIT 许可，没有网络权限、不记录输入文本。构建需要 JDK 17、Android SDK Platform 35 与 Gradle 8.9；在已配置 Android 构建环境的机器执行 `gradle -p android/workbench-ime assembleDebug`。项目未捆绑二进制 Gradle wrapper、SDK、签名私钥或预编译 APK。构建产物在 app/build/outputs/apk/debug；长期使用应由管理员用自己的密钥签名并保管密钥。拯救者已经完成 APK 构建、安装以及中文、换行和 emoji 的现场输入验收。

仅在 Lenovo 上，用经核实的 adb.exe 及固定 `-s AYCVVB2B09005827` 安装经过审核的 APK，记录原来的 `settings get secure default_input_method` 值。通过手机设置启用并选择 `org.workbench.ime/.WorkbenchIme`，或在明确的本机维护阶段使用 `ime enable` 与 `ime set` 完成相同操作。之后将 ime_enabled 设为 true，并在维护窗口重新启动 Lenovo 该实例的 stdio 进程。不要启动或重启 Phone-Host。

版本 `1.7.0-local.11` 起，`ime_enabled=true` 时，获取手机控制权会自动启用并选中已安装的 Workbench 输入法，`text_input` 返回准备结果。随后重新观察页面，建立当前输入框的焦点依据。释放控制权后保留该输入法，方便无人值守使用；用户手动换用其他键盘后，下次获取控制权会重新准备。输入法缺失或切换失败时仍可使用其他手机操作，文字输入按返回的状态处理。

在无敏感信息的空白备忘录中验收输入，依次 acquire、observe、input，使用随机 request_id，测试包含中文、换行与 emoji 的 append/replace。append 定义为在字段末尾追加，replace 定义为替换整个字段；输入法要求编辑器支持完整文本提取与选区，否则拒绝并返回不确定结果供观察。核对文本实际落入目标字段后释放租约，按手机用途保留 Workbench 输入法或切回用户日常键盘。IME 的成功回执表示 InputConnection 接受提交，实际显示仍须核对。

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

配置经过现场验证的 `scrcpy_path` 后，`physical_off` 使用短期控制连接关闭物理面板，并核对 SurfaceFlinger 状态；原投屏与 Phone-Host 继续运行。`dark_on_wake` 在自动唤醒后恢复暗屏，已经由用户点亮的屏幕保持原状态。USB 断开或授权失效时按现场状态恢复连接，恢复工具保留原 ADB 服务与授权密钥。

## 已覆盖与待验证

fake device 测试覆盖 MCP schema 与调用、共享租约、持久去重、不确定结果、窗口/旋转/像素变化、USB 状态、图像尺寸与预算，以及真实 Windows 子进程被终止后的锁恢复。完整仓库测试用于核对 host、workspace 和任务功能回归。

现场已验证当前运行账户的 ADB 授权、MagicOS 状态读取、控件定位、中文输入法及物理暗屏操作，具体操作和版本见验收记录。手机重启后的首次解锁、保护窗口及 USB 重新授权依设备状态处理；Windows 重启、锁屏和断网恢复测试按用户要求暂缓。
