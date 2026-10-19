# 控件定位与动作后观察验收

2026-10-18，LAPTOP-NHHRR3GO / HONOR 80，部署版本 `1.7.0-local.5`。

## 已部署

- `phone_observe(ui:true,image:false)` 返回新控件列表，不截图。Agent 根据文字、resource_id 或描述选择 element_id。
- `phone_input(action:{type:tap_element,element_id},frame_id,lease_id,request_id)` 在执行前再次读取 UI；检查唯一目标、祖先、位置、状态、可点击子树、窗口和至少半数页面锚点。目标改变或无法确认时拒绝。
- 保留图像坐标回退及上一版的目标区域像素检查；保留全部主机、文件和 Codex 功能，不新增独立隧道。
- 动作后短暂等待；焦点消失或窗口切换造成截图失败时，最多额外读取两次，绝不重发点击。仍无法确定时保留 outcome_unknown。
- 工具说明明确要求核对动作后的画面，completed 不能当作业务成功。

## 证据

TypeScript 编译通过。手机专项 38 项全部通过；完整测试 328 项中 326 通过、2 跳过、0 失败。测试包含重复/遮挡/禁用/改名/移动控件、页面大幅变化、缺失 UI、无图片观察不能授权坐标、动作去重、Unicode、协议工具发现、崩溃恢复及原主机工具兼容。

本机 STDIO MCP 真机测试：打开系统设置，读取“显示和亮度”控件，用 fresh_ui_target 点击后进入对应页面；新画面和之后的 UI 都确认成功。打开设置发生过一次焦点切换，第二次只读观察成功，没有重新启动应用。

用户随后刷新 ChatGPT 中的 Legion 插件。真实云端 MCP 调用 `phone_observe(ui:true,image:false)` 返回无图片控件；调用 `tap_element` 成功进入“显示和亮度”，返回 `input_validation:fresh_ui_target`，截图确认对应页面。server_status 返回 `semantic-target-v2` 和 `1.7.0-local.5`。

云端收尾 HOME 因新旧图像有变化被拒绝，未派发该按键、未盲目重复；后续实体屏关闭成功并释放租约。先前本机 HOME/暗屏测试成功。实体屏关闭与 Android 唤醒、ADB 在线可共存。

## 边界

控件定位仍通过 Android 软件输入派发，不能隐去自动化身份，也不能证明美团先前验证码的触发原因。没有加入伪造压力、伪装设备、随机轨迹或第三方验证码服务；没有重复测试下单、加购或验证码。此次真机语义点击验证的是系统设置，不能将它写成美团控件或免验证码验收。

自绘页面、UI dump 超时、不可访问控件和并发外部触摸仍可能需要重新观察或坐标回退。页面锚点与遮挡检查是保守启发式，不能保证所有自绘遮挡都可识别。

本地变更基于 `6b89310`，尚未推送远端。原 Phone-Host、scrcpy 常驻守护及 ROG Workbench 未改动。回退副本在 `D:\StudyServer\codex-generated\deployment\phone-semantic-before-20261018`；私有配置和凭据不进入提交。
