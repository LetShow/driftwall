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

### 打包

```bash
npm run pack
```

产物在 `dist/`：`Driftwall-x.y.z-portable.exe` —— 单文件便携版，双击即用，无需安装，也不会在桌面创建快捷方式。

首次运行后，`db/`、`images/`、`temp/` 会生成在 **exe 所在目录**（便携版通过 `PORTABLE_EXECUTABLE_DIR` 定位），整个文件夹拷走即可迁移。建议把 exe 放在有写权限的普通文件夹（如 `D:\Tools\Driftwall\`），不要放在 `C:\Program Files\` 下。

> 如需传统安装包，在 `package.json` 的 `build.win.target` 里加回 `"nsis"` 再打包。

## ⚙️ 配置说明

### API 接口

程序调用的是 **OpenAI 兼容格式**，两组接口各填「完整 URL + API Key」：

| 用途 | 默认接口 | 请求体关键字段 |
|------|---------|---------------|
| 生成提示词 | `POST .../v1/chat/completions` | `messages`、`max_tokens: 512`、`temperature: 1.0` |
| 生成图片 | `POST .../v1/images/generations` | `prompt`、`size: "4K"`、`ratio: "16:9"`、`extra_body.response_format = "url"` |

- 文生图响应需为 `{ data: [{ url: "..." }] }`，程序会再下载该 URL
- **模型名目前写在 `main.js` 里**（`agnes-3.0-flash` / `agnes-image-2.5-flash`），接入其他服务商时请改成对应模型名
- 提示词与图片接口的超时时间可在设置页调整（默认 120s / 180s）

### 主要设置项（存于 `db/wallpaper.db` 的 `settings` 表）

| 键 | 说明 |
|----|------|
| `model_url` / `api_key` | LLM 接口地址与 Key |
| `image_url` / `image_key` | 文生图接口地址与 Key |
| `interval` | 自动换壁纸间隔（分钟） |
| `change_mode` | `random`（加权随机）/ `sequential`（按顺序） |
| `style_explore_rate` | 风格探索比例，默认 0.5 |
| `image_dir` | 图片保存目录，默认程序目录下 `images/` |
| `temp_clean_interval` | 临时图片保留天数，0 = 永不清理 |
| `wallpaper_display` | 目标显示器：`primary` / `current` / 索引 |
| `float_position` / `float_x` / `float_y` | 悬浮按钮贴边方向与坐标 |
| `llm_timeout` / `image_timeout` | 接口超时（秒） |

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
├── renderer/
│   ├── index.html              # 设置 / 预览主界面
│   ├── app.js                  # 主界面逻辑
│   └── float.html              # 悬浮按钮窗口（含样式与逻辑）
├── db/wallpaper.db             # SQLite 数据库（运行时生成，已忽略）
├── images/                     # 生成的壁纸（已忽略）
├── temp/                       # 被"不喜欢"的图片（已忽略）
├── 随机壁纸_方案.md             # 需求 / 数据库设计 / 业务流程
├── ADR-001-技术选型.md          # 架构决策记录
├── GLOSSARY.md                 # 领域术语表
└── dist/                       # 打包产物（已忽略）
```

## 📚 设计文档

- [`随机壁纸_方案.md`](./随机壁纸_方案.md) — 完整需求、数据库设计、业务流程
- [`ADR-001-技术选型.md`](./ADR-001-技术选型.md) — 架构决策记录（技术选型、双轨生成、权重算法、Key 存储等 10 篇）
- [`GLOSSARY.md`](./GLOSSARY.md) — 领域术语表（风格种子、预生成库、权重、探索比例…）

## 🗺️ Roadmap

- [ ] 打开设置页时展示「模型名」输入框，去掉代码里的硬编码
- [x] 应用图标（`build/icon.ico`，由应用内置的文生图模型生成）
- [ ] API Key 简单加密存储 / 接入系统凭据管理器
- [ ] 代码签名，减少杀毒软件误报
- [ ] 自动更新（electron-updater）
- [ ] macOS / Linux 支持
- [ ] 中文提示词直出与本地化界面

## 🤝 贡献

欢迎 Issue / PR。提交前请确认：

1. 不要提交 `db/`、`images/`、`temp/`、`dist/` 与任何包含 API Key 的文件
2. 改动涉及流程或数据结构时，同步更新 `随机壁纸_方案.md` / `ADR`
3. 打包产物请自行验证一遍（`npm run pack`）

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
