<p align="center">
  <img src="build/icon.png" width="120" alt="Driftwall icon">
</p>

# Driftwall · AI 随机壁纸引擎

> 让桌面自己漂移成一片风景。LLM 写提示词，文生图出图，一键变壁纸，再按你的喜好自我进化。

[![platform](https://img.shields.io/badge/platform-Windows-0078D6)](https://github.com/LetShow/driftwall)
[![electron](https://img.shields.io/badge/Electron-28-47848F?logo=electron&logoColor=white)](https://github.com/LetShow/driftwall)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-LetShow%2Fdriftwall-181717?logo=github)](https://github.com/LetShow/driftwall)

Driftwall 是一个 Windows 桌面壁纸工具：它用 LLM 生成风格各异的英文提示词，调用文生图 API 生成 4K 壁纸，自动设为系统桌面背景；又通过桌面边缘的悬浮按钮收集"喜欢 / 不喜欢"，把反馈折算成关键字权重，让下一次生成的壁纸越来越对味。

**没有云端服务，没有账号体系。** 所有数据（设置、图片记录、关键字权重、API Key）都存在程序目录下的本地 SQLite 里，整个文件夹拷走即可迁移。

---

## ✨ 功能特性

- **全自动出图**：LLM 生成提示词 → 文生图 API → 下载 → 设为桌面壁纸，全流程无需人工干预
- **双轨生成策略**
  - 方法 A（后台预生成）：先抽风格种子 → 生成提示词 → 出图，可控、耐看，程序空闲时慢慢攒图
  - 方法 B（急需时快出）：先生成图片 → 从提示词里提取关键字，2 次调用即可上墙
- **预生成库**：空闲时后台预生成最多 10 张待选壁纸，换壁纸时直接取图，秒出
- **六维风格随机池**：艺术风格 / 主题 / 色调 / 光照 / 构图 / 氛围 各 10~24 个候选，每次抽一套"风格种子"写进约束，避免连续撞衫；抽签自动避开最近用过的选项
- **探索 / 利用平衡**：`风格随机程度` 可调（20% / 50% / 80% / 100%），决定本次"主题"是纯随机探索还是参考你的历史偏好
- **悬浮按钮**：贴屏幕边缘的透明小窗，鼠标移入显示「喜欢 / 不喜欢 / 下一个 / 设置」，移出淡出；可拖动到任意屏幕边缘，位置自动记忆
- **个性化权重**：喜欢 → 图片权重 +10、图中关键字各 +1；不喜欢 → 标记 `disliked` 不再出现、关键字各 -1；忽略 → 权重 -1
- **两种切换方式**：加权随机，或按生成先后顺序循环
- **定时自动更换**：node-cron 按分钟级间隔自动换壁纸（最小 5 分钟）
- **多显示器自适应**：按目标显示器的实际宽高比生成（16:9 / 21:9 / 16:10 / 4:3 / 3:2 / 1:1），4K 分辨率输出
- **按显示器设置壁纸**：可将壁纸只设到指定显示器（经 Windows `IDesktopWallpaper`），也可选「轮流更换」让每次换壁纸轮到下一台屏幕，游标持久化、重启后接着轮
- **调用频率限制**：LLM 与文生图各自可配置时间窗口内的调用上限与超限暂停时长，避免被服务方限流
- **主题配色自定义**：主色、背景、卡片、文字、边框、圆角、按钮颜色、隐藏延迟均可调，主界面与悬浮窗同步
- **托盘常驻**：关闭窗口不退出，从托盘随时重开或彻底退出
- **临时文件自清理**：不喜欢的图片移入 `temp/`，按设定的保留天数（0/1/7/30）自动清理
- **绿色便携**：sql.js 纯 JS 实现，无需编译原生模块；打包后目标机器无需安装 Node.js

## 🔄 工作流程

```
         ┌──────────── 空闲 N 分钟 ────────────┐
         ▼                                    │
  抽取风格种子（6 维随机）                       │
         │                                    │
         ▼                                    │
  LLM 生成英文提示词 + KEYWORDS 标签              │  方法 A
         │                                    │  （后台攒图）
         ▼                                    │
  文生图 API（4K，按屏幕比例）                    │
         │                                    │
         ▼                                    │
  下载 → 存入 images/ → 记入数据库 ──────────────┘
         │
         ▼
  用户点「下一个」/ 定时到点 / 点「不喜欢」
         │
         ▼
  预生成库有图？ ── 有 ──► 直接上墙（秒出）
         │ 无
         ▼
  现场生成（方法 B）──► 上墙
         │
         ▼
  悬浮按钮：喜欢 +10 / 不喜欢 -1 分并换下一张 / 忽略 -1
```

## 🧱 技术栈

| 层 | 选型 |
|----|------|
| 桌面框架 | Electron 28 |
| 界面 | 原生 HTML / CSS / JavaScript |
| 数据存储 | SQLite（[sql.js](https://github.com/sql-js/sql.js)，纯 JS，无需编译） |
| HTTP | axios |
| 定时任务 | node-cron |
| 设置壁纸 | [wallpaper](https://www.npmjs.com/package/wallpaper) |
| 打包 | electron-builder（单文件便携版，免安装） |

## 🚀 快速开始

**环境要求**：Windows 10/11、Node.js ≥ 18

```bash
git clone https://github.com/LetShow/driftwall.git
cd driftwall
npm install
npm start
```

启动后在设置页填写两组接口信息（见下节），点「立即换壁纸」即可。

### 测试

```bash
npm test
```

离线 mock 覆盖 4 种返回形态（url / b64_json / 二进制 / 异步轮询）与 4 种认证方式，不需要真实 Key。

### 打包

```bash
npm run pack
```

产物在 `dist/`：`Driftwall-x.y.z-portable.exe` —— 单文件便携版，双击即用，无需安装，也不会在桌面创建快捷方式。

首次运行后，`db/`、`images/`、`temp/` 会生成在 **exe 所在目录**（便携版通过 `PORTABLE_EXECUTABLE_DIR` 定位），整个文件夹拷走即可迁移。建议把 exe 放在有写权限的普通文件夹（如 `D:\Tools\Driftwall\`），不要放在 `C:\Program Files\` 下。

> 如需传统安装包，在 `package.json` 的 `build.win.target` 里加回 `"nsis"` 再打包。

## ⚙️ 配置说明

### API 接口

LLM 与文生图各存一套 **Profile**（`settings` 表的 `llm_profile` / `image_profile`）。设置页「模型接入」里选模板后填地址、Key、模型名即可：

| 模板 | 适用服务 | 说明 |
|------|---------|------|
| OpenAI 兼容 | 各类中转站、DeepSeek、硅基流动、通义兼容模式 | 默认 `Authorization: Bearer`，读 `choices[0].message.content` / `data[0].url` |
| Azure OpenAI | Azure 部署 | 认证头 `api-key`，地址里带 `deployments` 与 `api-version` |
| Stable Diffusion WebUI | 本地 `/sdapi/v1/txt2img` | 返回 `images[0]` base64，无需认证 |
| 自定义 JSON | 兜底 | 请求头、请求体、响应路径、轮询字段全部可改 |

- 认证方式支持 `Bearer` / `x-api-key` / `api-key` / URL 查询参数（`?key=`）/ 无认证，可再叠加自定义请求头
- 返回形态支持 `url` 再下载、`b64_json`、二进制图片流、异步任务轮询、Chat 回复里的 Markdown 图片链接
- 尺寸按目标显示器比例从模板档位里就近选择；也可在「自定义尺寸」里覆盖，或选「不发送尺寸参数」
- 超时 / 网络错误 / 5xx 自动重试 1 次；4xx 直接报错。预生成失败按 60 秒 → 5 分钟 → 15 分钟退避
- 「测试连接」会显示耗时、返回摘要与 HTTP 状态码；文生图测试会真实生成一张小图（不保存），可能消耗额度

### 调用频率限制

设置页「调用频率限制」里，LLM 与文生图各自统计：`windowMinutes` 分钟内最多调用 `maxCalls` 次，超限后暂停 `penaltyMinutes` 分钟。默认 LLM 为 60 分钟 30 次、超限暂停 30 分钟；文生图为 60 分钟 20 次、超限暂停 60 分钟。

- 成功与失败的请求都计数，累计记录存在 `api_usage` 表，保留最近 7 天
- 预生成、立即换壁纸、定时换壁纸都受限制；触顶前会先检查两个接口的额度，避免白白调用 LLM
- 被暂停后可在该页点「清空统计」立即解除，适合改错配置后恢复

### 主要设置项（存于 `db/wallpaper.db` 的 `settings` 表）

| 键 | 说明 |
|----|------|
| `llm_profile` | LLM 接口配置（JSON：模板 / 地址 / Key / 模型 / 认证 / 请求体 / 响应路径 / 轮询） |
| `image_profile` | 文生图接口配置（同上，另含尺寸档位与下载鉴权） |
| `interval` | 自动换壁纸间隔（分钟） |
| `change_mode` | `random`（加权随机）/ `sequential`（按顺序） |
| `style_explore_rate` | 风格探索比例，默认 0.5 |
| `image_dir` | 图片保存目录，默认程序目录下 `images/` |
| `temp_clean_interval` | 临时图片保留天数，0 = 永不清理 |
| `wallpaper_display` | 壁纸设置到哪个显示器：`all`（所有显示器）/ `rotate`（轮流）/ `primary`（仅主显示器）/ `current` / 索引 |
| `wallpaper_display_cursor` | 轮流模式的游标（下一次轮到第几台），程序自动维护 |

> 多显示器：`wallpaper` 包在 Windows 上只设置主显示器。选择「仅主显示器」或具体显示器时，程序改用系统自带的 `IDesktopWallpaper`（Windows 8+，经 `lib/windows-wallpaper.ps1` 调用）只更新目标显示器；调用失败会自动回退为全局设置并写日志。
>
> 轮流模式：每次换壁纸按屏幕从左到右的顺序换到下一台（显示器 1 → 2 → 1 …），图片比例按本次要换上的屏幕生成，游标持久化，重启后接着轮。
| `float_position` / `float_x` / `float_y` | 悬浮按钮贴边方向与坐标 |
| `float_hide_delay` | 鼠标移开后自动收起延迟（毫秒） |
| `llm_timeout` / `image_timeout` | 接口默认超时（秒），Profile 里填了 `timeoutSec` 时以 Profile 为准 |
| `preload_enabled` / `preload_idle` / `preload_max` | 预生成开关、空闲分钟数、库存上限 |
| `llm_rate_limit` / `image_rate_limit` | 调用频率限制（JSON：`enabled` / `windowMinutes` / `maxCalls` / `penaltyMinutes`） |

> 旧字段 `model_url` / `api_key` / `image_url` / `image_key` 会在启动时自动迁移到两份 Profile，之后不再读取。

## 🔐 数据与隐私

- 所有数据仅存本地：`db/wallpaper.db`（设置、图片索引、关键字权重）、`images/`（图片）、`temp/`（已不喜欢的图片）
- **API Key 以明文保存在本地数据库中**，请勿使用高价值 Key；不要把 `db/` 或打包后的程序目录分享给别人
- 仓库已通过 `.gitignore` 排除：`db/`、`images/`、`temp/`、`dist/`、`.env*`、`node_modules/`、日志与本地工具目录
- 程序不收集任何遥测数据，图片生成请求只会发往你自己填写的接口地址

## 📁 目录结构

```
.
├── main.js                     # 主进程：窗口、数据库、生成流程、托盘、定时任务
├── preload.js                  # contextBridge 安全桥接，向前端暴露 wallpaperApi
├── lib/adapters.js             # 接口适配层：模板、请求规划、响应解析、轮询、重试判定
├── lib/windows-wallpaper.ps1   # 按显示器设置壁纸（IDesktopWallpaper COM，Windows 8+）
├── renderer/
│   ├── index.html              # 6 页设置界面（模型接入 / 生成与换壁 / 预生成 / 频率限制 / 悬浮按钮 / 主题）
│   ├── app.js                  # 主界面逻辑
│   └── float.html              # 悬浮按钮窗口（含样式与逻辑）
├── test/adapters.test.js       # 离线 mock 测试（4 种返回形态 × 4 种认证）
├── db/wallpaper.db             # SQLite 数据库（运行时生成，已忽略）
├── images/                     # 生成的壁纸（已忽略）
├── temp/                       # 被"不喜欢"的图片（已忽略）
├── logs/                       # 运行日志，保留 7 天（已忽略）
├── docs/CHANGELOG.md           # 按版本记录改动（现象 / 根因 / 验证）
├── 随机壁纸_方案.md             # 需求 / 数据库设计 / 业务流程
├── ADR-001-技术选型.md          # 架构决策记录
├── GLOSSARY.md                 # 领域术语表
└── dist/                       # 打包产物（已忽略）
```

## 📚 设计文档

- [`随机壁纸_方案.md`](./随机壁纸_方案.md) — 完整需求、数据库设计、业务流程
- [`ADR-001-技术选型.md`](./ADR-001-技术选型.md) — 架构决策记录（技术选型、双轨生成、权重算法、Key 存储、接口适配等 12 篇）
- [`GLOSSARY.md`](./GLOSSARY.md) — 领域术语表（风格种子、预生成库、权重、探索比例、格式模板…）
- [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — 按版本记录改了什么、为什么、怎么验的

## 🗺️ Roadmap

- [x] 打开设置页时展示「模型名」输入框，去掉代码里的硬编码（随 1.1 的适配层完成，见 ADR-011）
- [x] 应用图标（`build/icon.ico`，由应用内置的文生图模型生成）
- [x] 托盘图标修复与新的托盘菜单（1.0.1，见 ADR-012）
- [ ] API Key 简单加密存储 / 接入系统凭据管理器
- [ ] 代码签名，减少杀毒软件误报
- [ ] 自动更新（electron-updater）
- [ ] macOS / Linux 支持
- [ ] 中文提示词直出与本地化界面

## 🤝 贡献

欢迎 Issue / PR。提交前请确认：

1. 不要提交 `db/`、`images/`、`temp/`、`dist/` 与任何包含 API Key 的文件
2. 改动涉及流程或数据结构时，同步更新 `随机壁纸_方案.md` / `ADR`
3. 每次改动在 `docs/CHANGELOG.md` 记一条：现象 / 根因 / 改动文件 / 验证方式；没实测过的写进"未验证项"
4. 打包产物请自行验证一遍（`npm run pack`）

## ❓ 常见问题

**打包时报 `Cannot create symbolic link : 客户端没有所需的特权`**
electron-builder 解压 `winCodeSign` 缓存时需要创建 macOS 符号链接。开启 Windows「开发者模式」（设置 → 隐私和安全性 → 开发者选项），或以管理员身份运行终端，再重新打包即可。

**装完被杀毒软件拦截**
未签名的 Electron 应用容易被误报，添加信任或自行签名即可。

**换壁纸报错"请先在设置里填写…"**
两组接口（LLM / 文生图）的 URL 和 Key 都需要填写，缺一不可。

## 👤 作者

**LetShow** · [github.com/LetShow](https://github.com/LetShow)

项目主页：[github.com/LetShow/driftwall](https://github.com/LetShow/driftwall) · 问题反馈：[Issues](https://github.com/LetShow/driftwall/issues)

## 📄 License

[MIT](./LICENSE) © 2026 LetShow
