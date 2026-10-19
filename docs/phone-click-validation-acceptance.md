# 荣耀 80 点击校验修复与实测

日期：2026-10-18（Asia/Shanghai）。主机：LAPTOP-NHHRR3GO。

## 问题与修正

Dots 在美团首页点击小象超市时，原实现要求整张截图的 PNG 哈希一致，轮播广告、搜索提示等无关变化也会触发 PHONE_FRAME_CHANGED。本机升级到 1.7.0-local.4，phone input validation 版本为 region-tap-v1。

- 点击和长按：焦点窗口、应用、物理尺寸、旋转保持一致；点击目标周围的像素块保持完全一致；其他变化像素块面积最多占整屏 25%。
- 比较解码后的 RGB 像素，不再把 PNG 压缩编码差异当成画面变化。
- 文字、按键、滑动仍采用整屏像素一致要求。
- 本机 frame_seconds 从 10 调整到配置已支持的 30 秒，点击前仍采集新画面检查。此项是本机配置，不改变仓库默认值。
- 保留独占控制、最新 frame_id、请求去重、未确认结果禁止重复执行和管理员暂停。

这是保守的视觉一致性检查，不是语义页面识别，不能消除截图与 Android 输入之间的竞态。目标自身的动画仍可能被拒绝。

## 验证

- TypeScript 检查通过，git diff --check 通过。
- 手机测试 27 项通过，包括远处广告变化放行、目标移动/覆盖阻止、整页大幅变化阻止、同应用切换窗口阻止、PNG 编码变化放行、错误比较元数据拒绝。
- 完整测试 317 项：315 通过、2 跳过、0 失败。日志保存在 D:\StudyServer\codex-generated\deployment\phone-click-full-tests.log。
- MCP 隧道实际返回 service_version=1.7.0-local.4、input_validation_version=region-tap-v1，ADB=device。
- 通过实际 MCP 隧道从美团首页点击小象超市入口，随后重新观察确认已进入小象超市。页面弹出了图片验证码，测试停在此处。

实际导航请求 click-fix-xiaoxiang-entry-test02 返回 outcome_unknown，因为动作后即时观察未完成；没有重放。随后独立 phone_observe 确认目标页面已经出现。这不将原请求的持久 pending 回执改写为成功，也不能证明该次实时调用具体走了整屏匹配还是区域匹配分支；区域放行分支有独立自动测试覆盖。

没有加购、下单、提交验证码或改变送货地址。已释放测试控制租约。Phone-Host、ADB 服务和手机系统没有重启或修改；只重载了 Legion MCP runtime。隧道重载后的首个调用出现过短暂超时，之后工具调用及最终 ready 检查恢复正常。

## 当前交接

Dots 可重新获取最新截图后继续使用原 phone_input 接口，参数不变。不要用新的 request_id 重放之前 outcome_unknown 的动作，应先观察当前页面。

源码已有其他本机修改，本次保留它们；未提交或推送仓库。修复前的本机源码与配置备份位于 D:\StudyServer\codex-generated\deployment\phone-click-before-20261018。
