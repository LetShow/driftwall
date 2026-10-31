# CHANGELOG

按版本记录改动，方便下次反查。每一版固定四栏：**现象 / 根因 / 改动文件 / 验证方式**；另有 **未验证项**，用于标明没有实机或真实 Key 验证过的部分。

决策原因不写在这里，写在 [`ADR-001-技术选型.md`](../ADR-001-技术选型.md)。

反查路径：
- 想知道"哪一版改的" → 本文件
- 想知道"为什么这么改、放弃了哪些方案" → ADR
- 想知道"怎么发版" → `发布操作手册.md`（本地，未入库）

---

## [未发布] 1.0.1 — 托盘图标与退出路径

> 状态：已实现并完成打包验证（2026-10-30），待发版。

### 现象
1. 程序启动后系统托盘没有图标，找不到退出入口，只能任务管理器结束进程。
2. 关闭设置窗口后程序仍在后台运行，但没有任何可见入口。

### 根因
- `main.js` 的 `createTrayIcon()` 用内联 SVG 生成图标；Electron `nativeImage` 不支持 SVG，实测 `isEmpty: true`、尺寸 `0×0`。
- `new Tray(空图标)` 不抛异常，失败被静默吞掉，日志里也没有痕迹。
- 主窗口 `close` 被拦截改为 `hide()`，托盘菜单成为唯一退出路径，而它不可见。
- 没有单实例锁，多开会生成多个隐形托盘，并同时跑定时任务。

### 改动文件
- `main.js`
  - 托盘图标改为 `loadTrayIcon()`：优先 `build/icon.ico`（打包进 asar），逐个降级 `build/icon.png`、内置 base64 PNG；每一步成功/失败都写日志
  - 托盘菜单改为 `buildTrayMenu()`，右键现算：喜欢 / 不喜欢 / 下一个 / 设置 / 退出；当前图已 liked/disliked 时对应项置灰
  - `trayRateImage()` / `trayNextWallpaper()` 复用 `rateImage()` / `changeWallpaper()`，结果通过 `float-hint` 推到悬浮窗，行为与按钮完全一致
  - `requestSingleInstanceLock()`：二次启动唤出已有实例的设置窗口，新进程退出
  - `setupLogging()`：`console.*` 统一落到 `dataRoot/logs/app-YYYY-MM-DD.log`，保留 7 天，Key 脱敏（`sk-*` / `Bearer *` / `?key=*` / `api_key:` 值）
  - 新增 IPC：`open-log-dir` / `get-log-dir`
- `preload.js`：`openLogDir` / `getLogDir` / `onFloatHint`
- `renderer/float.html`：监听 `float-hint`，与按钮点击同一条提示通道
- `renderer/index.html` + `renderer/app.js`：窗口底部"打开日志目录"链接
- `package.json`：`build.files` 加入 `build/icon.ico`、`build/icon.png`，保证 asar 内有图标

### 验证方式
- 开发模式（`npm start`）实跑（Win11，2026-10-30）：
  - 日志：`[托盘] 图标已加载: build\icon.ico (256x256)` → `[托盘] 创建完成`
  - 单实例：先起一个再起第二个 → 新进程退出；日志 `[单实例] 收到第二次启动请求` 一条
  - 日志脱敏：`api_key` 值以 `sk-*` 形式出现时已被替换为 `***`
- 打包产物（`dist\win-unpacked\Driftwall.exe`）实跑：
  - stdout：`[托盘] 图标已加载: ...app.asar\build\icon.ico (256x256)`，图标在 asar 内加载成功
  - `logs\app-YYYY-MM-DD.log` 生成在 exe 同目录；`db/` 落在 `dataRoot`（绿色迁移路径正常）
  - 二次启动：新进程 `second_alive=False`，日志 `[单实例] 收到第二次启动请求，唤出设置窗口` 一条

### 未验证项
- `dist\Driftwall-1.0.0-portable.exe`（portable 外壳）本身尚未双击跑通，验证的是 unpacked exe
- Windows 10 实机
- 托盘图标在 125% / 150% 缩放下的清晰度
- Explorer 重启后托盘图标是否恢复
- 托盘菜单"喜欢/不喜欢/下一个"点击反馈行为（代码层面已确认与悬浮窗按钮复用同一通道，未实机点击验证）

---

## [未发布] 1.1 — 多格式 API 适配层

> 状态：已实现（2026-10-31），待发版。方案见 ADR-011。

### 现象
只有一种 OpenAI 兼容接法，且模型名、出图参数写死在代码里；换成别家（含同为 OpenAI 兼容但尺寸/模型名不同的服务）就会失败。

### 根因
- 协议写死：`Authorization: Bearer`、`choices[0].message.content`、`data[0].url`
- 模型名写死：`agnes-3.0-flash` / `agnes-image-2.5-flash`
- 出图参数写死：`size: "4K"`、`ratio`、`extra_body.response_format: "url"`

### 改动文件
- `lib/adapters.js`（新增）
  - 模板：`openai-compatible` / `azure-openai` / `sd-webui` / `custom-json`
  - Profile 归一化、请求体深合并、占位符替换（`{{model}}` / `{{prompt}}` / `{{messages}}` / `{{size}}` / `{{ratio}}` / `{{width}}` / `{{height}}`）
  - 4 种认证、JSON 路径取值、按屏幕比例选尺寸档位
  - 响应解析：url / b64_json / 二进制 / 异步轮询 / Chat 内嵌 Markdown
  - 按 `Content-Type` 与文件魔数判断扩展名；5xx/超时/网络错误可重试判定
- `main.js`
  - `migrateApiProfiles()`：旧 `model_url` / `api_key` / `image_url` / `image_key` 迁移为两份 Profile（保留 Agnes 的 4K + ratio + `extra_body` 参数），旧字段保留但不再读取
  - `callPromptLLM()` / `generateImage()` 改为走 Profile；文生图支持二进制响应、异步轮询、下载鉴权
  - `apiRequest()` 统一超时与重试；`describeApiError()` 输出可读错误（HTTP 状态 + 服务端 message），并对错误文本再做一次 Key 脱敏
  - `testConnection()`：LLM 发一条极短消息，文生图真实生成一张小图（不保存）
  - 预生成失败改为 60 秒 → 5 分钟 → 15 分钟退避，`preload-status` 推送暂停原因与下次尝试时间；修改模型配置或手动“立即重试”清除暂停
  - 修复预生成配置重启后不回读 `settings` 的问题（此前界面显示已关闭、后台仍按默认值运行）
  - 日志脱敏补上 Profile JSON 里的 `"key":"..."`（原规则只覆盖 `api_key` / `image_key`）
  - 主窗口尺寸 900×700 → 1000×720
  - 新增 IPC：`get-profile-meta` / `get-profile-defaults` / `get-profiles` / `save-profile` / `test-connection` / `get-preload-status` / `reset-preload-backoff`
- `preload.js`：暴露上述 Profile、测试连接、预生成状态、`onApiError`、`onPreloadStatus`；`onProgress` 返回取消订阅函数
- `renderer/index.html`：改为左侧 5 页导航（模型接入 / 生成与换壁 / 预生成 / 悬浮按钮与显示器 / 主题外观），模型页含模板、地址、Key、模型名与可折叠高级区；顶部 API 错误横幅；窗口底部保留“打开日志目录”
- `renderer/app.js`：Profile 读写与模板默认值、测试连接结果、页面切换、错误横幅、预生成暂停状态、保存前 JSON 校验
- `package.json`：`build.files` 加入 `lib/**/*`；新增 `npm test`
- `test/adapters.test.js`（新增）：本地 mock 服务器，覆盖 4 种返回形态 × 4 种认证
- `.gitignore`：允许提交 `test/adapters.test.js`，其余本地测试文件继续忽略
- `README.md` / `ADR-001-技术选型.md` / `docs/CHANGELOG.md`：同步模板、Profile、测试与状态

### 验证方式
- `npm test`（Node 22）：12 项全部通过
  - 认证：bearer / x-api-key / api-key / query / none
  - 返回：url、b64_json、二进制流、异步轮询（pending → success）
  - Chat 内嵌 Markdown 图片链接、请求体深合并、尺寸就近选择、重试判定、JSON 路径
- 开发模式实跑（2026-10-31）：
  - 旧配置自动迁移成功，日志出现 `[配置] 已把旧的接口设置迁移为 Profile`
  - 5 页导航可切换，模板下拉与高级区默认值正确
  - 保存后重新读取 Profile，`size: "4K"`、`sizeMode: "none"`、轮询默认值均保持
  - **真实 Agnes 文生图跑通**：迁移后的 Profile 发出 `{model, prompt, size:"4K", n:1, ratio:"16:9", extra_body:{response_format:"url"}}`，从 `data[0].url` 取到图片，下载 1,813,631 字节，按 `Content-Type` 判定为 `png`（URL 本身无扩展名）
  - 「测试连接」对真实 Agnes 的 429 返回 `HTTP 状态：429` + 可读详情（Key 已脱敏），界面不崩
  - 保存时请求体填非法 JSON，界面提示具体 JSON 解析错误且不落库
- 打包产物（`dist-test\win-unpacked\Driftwall.exe`，输出目录与 `dist/` 隔离以免覆盖用户数据）实跑：
  - asar 内包含 `lib/adapters.js`，5 页界面与 Profile IPC 正常
  - 空配置下测试连接返回 `接口地址为空`，不抛异常

### 未验证项
- Gemini / Anthropic / 豆包 / 通义 / ComfyUI 原生协议：无 Key，**未实测**
- Azure OpenAI：无订阅，**未实测**
- SD WebUI：本地未部署，**未实测**；其 base64 解析仅经 mock 验证
- 二进制响应、异步轮询、下载携带鉴权：仅经 mock 验证，未对接真实服务商
- `dist\Driftwall-1.1.0-portable.exe` portable 外壳本身未双击验证
- Windows 10 实机、125% / 150% 缩放下的新设置页布局

---

## 2026-10-30 — 文档

### 现象
ADR 与代码不一致：ADR-008 描述的能力未实现；ADR-010 写了开机自启但代码无对应调用；文件末尾"后续开发计划"大部分已完成却仍标待开发。

### 改动
- ADR-008 标记为「已被 ADR-011 替代」，原文保留
- ADR-010 标记「部分内容未实现」，并注明 autoLaunch 未落地
- 新增 ADR-011（适配层）、ADR-012（托盘与退出路径）
- 删除 ADR 文件末尾的「后续开发计划」，进度改由本文件记录
- 新增本文件；README 的文档索引、目录结构、贡献约定同步
- GLOSSARY 增加：格式模板、Profile、异步轮询、托盘

### 验证方式
- 通读 ADR-011/012 与本次讨论结论逐条对照
- `git diff` 确认旧 ADR 正文除状态行外未被改写
