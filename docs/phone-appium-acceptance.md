# Appium 手机操作验收

日期：2026-10-19。主机为 `LAPTOP-NHHRR3GO`，运行账户为 `常可依`，手机为荣耀 80，ADB 序列号为 `AYCVVB2B09005827`。

## 实际实现

Workbench 1.7.0-local.6 接入本机 Appium 3.8.0 与 UiAutomator2 8.7.0，保留原有主机工具和九个手机工具。控件读取与触摸事件使用 Appium，应用启动、截图和 Workbench IME 继续使用现有 ADB 通道。Appium 监听 `127.0.0.1:4735`，通过原 Workbench MCP 隧道调用。

`tap_element` 在重新核对目标后选取目标内部的小幅变化位置，并以 80–160 毫秒的按住时间发送触摸。长按使用指定时长，滑动使用同一次手指触摸中的连续移动事件。`wait_for` 可等待目标文字或控件出现、可用或消失，返回匹配结果和后续观察。

## 荣耀 80 现场验证

临时测试应用在 Activity 中记录 Android MotionEvent，数据只包含测试操作的事件类型、坐标和时间。共收到六组手势，与六次调用一一对应，未出现重复发送。

| 操作 | Android 实际记录 | 结果 |
| --- | --- | --- |
| 三次控件点击 | 按下、抬起；分别为 120、100、140 毫秒 | 目标文字变为 Tapped |
| 延迟目标按钮 | 按下、抬起；160 毫秒 | 等待到 1.2 秒后出现的 Ready，约 2.63 秒内返回 |
| 650 毫秒长按 | 按下、抬起；660 毫秒 | 接收成功 |
| 420 毫秒滑动 | 按下、20 个移动事件、抬起；422 毫秒 | 起终点符合请求，downTime 一致 |

上述事件的 toolType 为 finger，source 为 touchscreen。三次普通点击落点分别为 `[537,241]`、`[538,239]` 和 `[537,238]`，均位于已确认的同一按钮内部。测试前后 SurfaceFlinger 均报告物理面板关闭。

主动结束测试用 Appium 会话后，后续读取重新建立会话成功，连续三次页面读取正常，物理面板继续保持关闭。该测试仅重建 Appium 会话，没有重启 ADB、手机或原 Phone-Host。

## 部署记录与复核

完整仓库回归共 345 项，343 项通过、2 项跳过，没有失败。本机 stdio 工具发现及手机读取通过，在线实例重载后，ChatGPT 通过原 Legion 插件读到版本 `1.7.0-local.6`，并成功执行 `tap_element`：实际使用 `appium_uiautomator2`，按住计划为 113 毫秒，随后页面文字为 Tapped。

当前会话的插件工具列表仍缓存旧参数表，传入新增 `wait_for` 时未送达服务端。该参数已通过本机和真机验收，网页端还需刷新 Legion Workbench 的工具元数据后，再做一次带此参数的云端验证。已有控件点击无需刷新即可使用新的触摸实现。

运行配置在 `D:\StudyServer\config\workbench\workspaces.json.phone.json`，守护入口为 `D:\StudyServer\config\start-phone-appium.ps1`。本机原始事件摘要和回归日志保存在 `D:\StudyServer\codex-generated\deployment`，其中 `appium-real-device-acceptance.json` 记录各次动作及事件核对结果。

Android SDK、Java 和 ADB 检查通过；Appium doctor 将未安装 emulator 记录为缺项，本次使用真实 USB 手机。Windows 重启、锁屏及断网恢复测试继续按用户安排暂缓。
