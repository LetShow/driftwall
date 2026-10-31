const { app, BrowserWindow, ipcMain, screen, Tray, nativeImage, Menu, shell } = require("electron");
const path = require("path");
const url = require("url");
const fs = require("fs");
const util = require("util");
const axios = require("axios");
const cron = require("node-cron");
const initSqlJs = require("sql.js");
const adapters = require("./lib/adapters");

// 运行时数据目录：开发时用项目目录；打包后放在 exe 同级目录（而不是 app.asar 内部），
// 这样数据库/图片仍可读写，拷走整个文件夹即可迁移（绿色软件）
// 便携版（portable）运行时 exe 会被解压到临时目录，此时必须用 PORTABLE_EXECUTABLE_DIR
// 指向用户双击的那个 exe 所在目录，否则数据会写进临时目录、退出即丢失
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataRoot = portableDir || (app.isPackaged ? path.dirname(process.execPath) : __dirname);

// 数据库文件路径（程序目录下的 db 文件夹，绿色软件可迁移）
const dbDir = path.join(dataRoot, "db");
const dbPath = path.join(dbDir, "wallpaper.db");

// 确保目录存在
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// ==================== 日志落盘 ====================
// 便携版没有控制台，日志同时写入 dataRoot/logs/app-YYYY-MM-DD.log，
// 方便用户回传、也方便事后排查托盘/接口问题。日志中的 Key 一律脱敏。
const logDir = path.join(dataRoot, "logs");
const LOG_RETENTION_DAYS = 7;
let logFilePath = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 2026-10-30：日志脱敏。覆盖 sk-xxx、Bearer xxx、?key=xxx、Profile JSON 里的 "key":"xxx"
function redactSecrets(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***")
    .replace(/\b(sk|ak|pk)-[A-Za-z0-9._\-]{4,}/gi, "$1-***")
    .replace(/([?&](?:key|api_key|api-key|access_token|token)=)[^&\s]+/gi, "$1***")
    .replace(
      /("?(?:api_?key|image_key|authorization|key|token|secret)"?\s*[:=]\s*"?)[^",\s}]+/gi,
      "$1***",
    );
}

// 只保留最近 7 天日志
function cleanOldLogs() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(logDir)) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const full = path.join(logDir, name);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(full);
      }
    }
  } catch (e) {
    // 清理失败不影响主流程
  }
}

function setupLogging() {
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const d = new Date();
    logFilePath = path.join(
      logDir,
      `app-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.log`,
    );
    cleanOldLogs();
  } catch (e) {
    logFilePath = null;
  }

  const writeLine = (level, args) => {
    if (!logFilePath) return;
    try {
      const line = `${new Date().toISOString()} [${level}] ${redactSecrets(
        util.format(...args),
      )}\n`;
      fs.appendFileSync(logFilePath, line, "utf8");
    } catch (e) {
      // 写日志失败时静默，避免递归
    }
  };

  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      writeLine(level.toUpperCase(), args);
    };
  }
}

setupLogging();

// 全局数据库对象（sql.js 异步初始化）
let db = null;
let dbReady = false;

// sql.js 辅助函数：执行查询返回第一行
function dbQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const hasRow = stmt.step();
  const row = hasRow ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

// sql.js 辅助函数：执行查询返回所有行
function dbQueryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// sql.js 辅助函数：执行写入/更新/删除
function dbExec(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();
}

// 初始化 SQLite（sql.js 是纯 JS，需要异步加载 wasm）
async function initDatabase() {
  const SQL = await initSqlJs({
    locateFile: (file) =>
      path.join(__dirname, "node_modules", "sql.js", "dist", file),
  });

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    console.log("[DB] 打开现有数据库:", dbPath);
  } else {
    db = new SQL.Database();
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE,
        prompt TEXT,
        keywords TEXT,
        status TEXT DEFAULT 'normal',
        weight INTEGER DEFAULT 100,
        created_at TEXT,
        last_shown TEXT
      );
      CREATE TABLE IF NOT EXISTS keywords (
        keyword TEXT PRIMARY KEY,
        score INTEGER DEFAULT 0,
        updated_at TEXT
      );
    `);
    console.log("[DB] 创建新数据库:", dbPath);
  }
  dbReady = true;
  migrateApiProfiles();
}

// 把旧版的四个接口字段迁移成两个 Profile（ADR-011）。
// 迁移时保留 Agnes 的 4K + ratio + extra_body 参数，避免升级后现有服务直接不可用。
function migrateApiProfiles() {
  try {
    if (getSetting("llm_profile")) return;
    const llm = adapters.normalizeProfile("llm", {
      template: "openai-compatible",
      url: getSetting("model_url"),
      key: getSetting("api_key"),
      model: "agnes-3.0-flash",
    });
    const image = adapters.normalizeProfile("image", {
      template: "openai-compatible",
      url: getSetting("image_url"),
      key: getSetting("image_key"),
      model: "agnes-image-2.5-flash",
      sizeMode: "none",
      responsePath: "data[0].url",
      body: {
        model: "{{model}}",
        prompt: "{{prompt}}",
        size: "4K",
        ratio: "{{ratio}}",
        extra_body: { response_format: "url" },
      },
    });
    setSetting("llm_profile", JSON.stringify(llm));
    setSetting("image_profile", JSON.stringify(image));
    console.log("[配置] 已把旧的接口设置迁移为 Profile");
  } catch (e) {
    console.error("[配置] 迁移接口设置失败:", e.message);
  }
}

// 持久化数据库到文件
function saveDatabase() {
  if (!db || !dbReady) return;
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    console.log("[DB] 数据库已保存到:", dbPath);
  } catch (e) {
    console.error("[DB] 保存数据库失败:", e.message);
  }
}

// 设置读写
function getSetting(key, defaultVal = "") {
  if (!dbReady) throw new Error("数据库未初始化");
  const row = dbQuery("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : defaultVal;
}
function setSetting(key, value) {
  if (!dbReady) throw new Error("数据库未初始化");
  dbExec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
    key,
    value,
  ]);
  saveDatabase();
  console.log("[DB] 设置已保存:", key, "=", value);
}

// 数据库就绪状态
ipcMain.handle("is-db-ready", () => dbReady);

// 创建主窗口（设置/预览界面）
let mainWin;
let isQuitting = false;

// 托盘图标，用于主窗口关闭后依然能找到程序并安全退出
let tray = null;

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.loadFile("renderer/index.html");

  // 主窗口关闭时隐藏到托盘，不退出程序；用户可通过托盘图标重新打开或退出
  mainWin.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWin.hide();
  });
}

// 创建悬浮按钮窗口（贴屏幕边缘，透明、无边框、置顶）
let floatWin;
function createFloatWindow() {
  // 支持多显示器：读取保存的显示器索引，默认主显示器(0)
  const displayIndex = parseInt(getSetting("float_display", "0"));
  const allDisplays = screen.getAllDisplays();
  const display = allDisplays[displayIndex] || allDisplays[0];
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  const { x: offsetX, y: offsetY } = display.workArea;

  // 更小的窗口尺寸，减少遮挡
  const winW = 100;
  const winH = 180;

  // 优先使用用户拖动后保存的坐标；否则按贴边位置计算
  const savedX = parseInt(getSetting("float_x"));
  const savedY = parseInt(getSetting("float_y"));
  let x, y;
  if (Number.isFinite(savedX) && Number.isFinite(savedY)) {
    x = savedX;
    y = savedY;
    // 拉回当前显示器工作区：
    // - 完全不在工作区内（分辨率/显示器变化）
    // - 或窗口尺寸变大（按钮增加）后下/右边被切掉
    const area = display.workArea;
    x = Math.min(Math.max(x, area.x), area.x + area.width - winW);
    y = Math.min(Math.max(y, area.y), area.y + area.height - winH);
  } else {
    // 读取保存的悬浮按钮位置，默认右上角
    const position = getSetting("float_position", "right-top");
    // 贴到屏幕边缘（外边距为 0），鼠标滑到屏幕边缘即可碰到悬浮窗
    const edge = 0;
    if (position === "left-top" || position === "left-bottom" || position === "left") {
      x = offsetX + edge;
      y = position === "left-bottom" ? offsetY + screenHeight - winH - edge : offsetY + edge;
    } else if (position === "right-bottom" || position === "bottom") {
      x = offsetX + screenWidth - winW - edge;
      y = offsetY + screenHeight - winH - edge;
    } else if (position === "top") {
      // 上边缘：贴右上（右侧是默认习惯位置）
      x = offsetX + screenWidth - winW - edge;
      y = offsetY + edge;
    } else {
      // right-top / right（默认）
      x = offsetX + screenWidth - winW - edge;
      y = offsetY + edge;
    }
  }

  floatWin = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000", // 窗口本身完全透明（不拦截透明区域鼠标）
    hasShadow: false, // 关闭系统阴影，避免方方正正的阴影框
    roundedCorners: false, // 关闭系统默认圆角，由 CSS 控制
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false, // 由前端自定义拖动实现
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  floatWin.loadFile("renderer/float.html");

  // 窗口加载完成后，把初始位置和当前壁纸发给前端
  floatWin.webContents.on("did-finish-load", () => {
    if (floatWin && !floatWin.isDestroyed()) {
      floatWin.webContents.send("float-pos", { x, y, w: winW, h: winH });
      notifyFloatCurrentImage();
    }
  });

  floatWin.winW = winW;
  floatWin.winH = winH;
}

// 显示主设置窗口（悬浮按钮、托盘菜单、第二次启动都走这里）
function showSettingsWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  } else {
    createMainWindow();
  }
}

// 打开主设置窗口（从悬浮按钮的“设置”按钮或托盘菜单进入）
ipcMain.on("open-settings", showSettingsWindow);

// 悬浮窗拖动：移动到新位置（限制在显示器内），拖动结束时才持久化
ipcMain.on("move-float", (event, x, y, persist) => {
  if (!floatWin || floatWin.isDestroyed()) return;
  const w = floatWin.winW || 100;
  const h = floatWin.winH || 180;
  // 防止拖出屏幕导致悬浮窗找不回来
  const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
  const nx = Math.min(Math.max(x, area.x), area.x + area.width - w);
  const ny = Math.min(Math.max(y, area.y), area.y + area.height - h);
  floatWin.setPosition(nx, ny);
  if (persist) {
    setSetting("float_x", String(nx));
    setSetting("float_y", String(ny));
  }
});

// ==================== 壁纸生成流程（带详细日志） ====================

// 获取超时设置（秒）
function getTimeoutSetting(key, defaultSec) {
  const val = parseInt(getSetting(key, String(defaultSec)));
  return val > 0 ? val * 1000 : defaultSec * 1000;
}

// 通知前端进度（通过 webContents.send）
function notifyProgress(message) {
  console.log("[进度]", message);
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("progress", message);
  }
}

// 设为桌面壁纸
let wallpaperModule = null;
async function getWallpaperModule() {
  if (!wallpaperModule) {
    wallpaperModule = await import("wallpaper");
  }
  return wallpaperModule;
}

async function setWallpaper(imagePath) {
  notifyProgress("正在设置桌面壁纸...");
  const wp = await getWallpaperModule();
  await wp.setWallpaper(imagePath);
  // 记录显示时间
  dbExec("UPDATE images SET last_shown = ? WHERE path = ?", [
    new Date().toISOString(),
    imagePath,
  ]);
  // 记录“当前显示中的壁纸”，悬浮按钮的喜欢/不喜欢就是对它操作
  const row = dbQuery("SELECT id FROM images WHERE path = ?", [imagePath]);
  if (row) setCurrentImageId(row.id);
  saveDatabase();
  notifyProgress("桌面壁纸已设置完成");
}

// ==================== 当前壁纸 & 喜欢/不喜欢 ====================

// 当前显示中的壁纸 id（悬浮按钮评价的对象）
let currentImageId = null;
// 是否正在换壁纸（防止重复触发）
let isChangingWallpaper = false;

// 取当前壁纸的完整记录（带 file:// 地址，供设置页预览）
function getCurrentImage() {
  if (!dbReady || !currentImageId) return null;
  const row = dbQuery("SELECT * FROM images WHERE id = ?", [currentImageId]);
  if (!row) return null;
  return { ...row, fileUrl: url.pathToFileURL(row.path).href };
}

// 设置当前壁纸 id，并推送给悬浮窗（悬浮窗据此知道该评价哪一张）
function setCurrentImageId(id) {
  currentImageId = id;
  notifyFloatCurrentImage();
}

function notifyFloatCurrentImage() {
  const image = getCurrentImage();
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.webContents.send("current-image", image);
  }
  // 主设置窗口同步收到，用于“当前壁纸预览”
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("current-image", image);
  }
}

// 2026-10-30：托盘操作后让悬浮窗给出与按钮点击一致的提示
function notifyFloatHint(message, kind) {
  if (!message) return;
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.webContents.send("float-hint", { message, kind: kind || "" });
  }
}

// 调整图片关键字分数：喜欢 +1，不喜欢 -1
function adjustKeywordScores(keywords, delta, now) {
  (keywords || []).forEach((kw) => {
    const krow = dbQuery("SELECT score FROM keywords WHERE keyword = ?", [kw]);
    if (krow) {
      dbExec(
        "UPDATE keywords SET score = score + ?, updated_at = ? WHERE keyword = ?",
        [delta, now, kw],
      );
    } else {
      dbExec(
        "INSERT INTO keywords (keyword, score, updated_at) VALUES (?, ?, ?)",
        [kw, delta, now],
      );
    }
  });
}

// 把“不喜欢”的图片文件移入 temp 目录（等新壁纸设好后再移，避免影响当前桌面）
function moveToTemp(imageId, imagePath) {
  const tempDir = path.join(dataRoot, "temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  if (!imagePath || !fs.existsSync(imagePath)) return;

  let target = path.join(tempDir, path.basename(imagePath));
  if (fs.existsSync(target)) {
    target = path.join(tempDir, Date.now() + "_" + path.basename(imagePath));
  }
  try {
    fs.renameSync(imagePath, target);
  } catch (e) {
    // 跨盘等场景 rename 会失败，降级为复制后删除
    try {
      fs.copyFileSync(imagePath, target);
      fs.unlinkSync(imagePath);
    } catch (e2) {
      console.error("[不喜欢] 移入临时目录失败:", e2.message);
      return;
    }
  }
  dbExec("UPDATE images SET path = ? WHERE id = ?", [target, imageId]);
  saveDatabase();
  console.log("[不喜欢] 图片已移入临时目录:", target);
}

// 不喜欢之后：先换下一张壁纸，成功后再把旧图移入 temp
async function changeAfterDislike(imageId, imagePath) {
  try {
    const result = await changeWallpaper();
    if (result && result.success) {
      moveToTemp(imageId, imagePath);
    } else {
      console.log("[不喜欢] 换壁纸未成功，暂不移动原图:", result && result.error);
    }
  } catch (e) {
    console.error("[不喜欢] 换壁纸异常:", e.message);
  }
}

// 喜欢 / 不喜欢 统一处理
function rateImage(imageId, type) {
  if (!dbReady) return { success: false, message: "数据库尚未就绪，请稍候重试" };

  const id = Number(imageId) || currentImageId;
  if (!id) {
    return {
      success: false,
      message: "当前还没有壁纸，请先在设置里换一张",
    };
  }
  const row = dbQuery("SELECT * FROM images WHERE id = ?", [id]);
  if (!row) return { success: false, message: "找不到这张图片的记录" };

  // 已经是这个状态就不重复计分
  if (row.status === type) {
    return {
      success: false,
      already: true,
      message: type === "liked" ? "这张已经标记过喜欢了 ❤️" : "已经标记过不喜欢了 👎",
    };
  }

  const now = new Date().toISOString();
  if (type === "liked") {
    dbExec(
      'UPDATE images SET status = "liked", weight = weight + 10 WHERE id = ?',
      [id],
    );
  } else {
    dbExec('UPDATE images SET status = "disliked" WHERE id = ?', [id]);
  }
  // 只有第一次评价（normal -> liked/disliked）才调关键字分，避免重复计分
  if (row.status === "normal") {
    adjustKeywordScores(JSON.parse(row.keywords || "[]"), type === "liked" ? 1 : -1, now);
  }
  saveDatabase();

  if (type === "liked") {
    return {
      success: true,
      status: "liked",
      message: "已标记喜欢，这张会更常出现 ❤️",
    };
  }
  // 不喜欢：只有当前正显示的这张才需要立刻换下一张
  const willChange = id === currentImageId && !isChangingWallpaper;
  if (willChange) changeAfterDislike(id, row.path);
  return {
    success: true,
    status: "disliked",
    changing: willChange,
    message: willChange
      ? "已标记不喜欢，正在换下一张…"
      : "已标记不喜欢，以后不会再出现 👎",
  };
}

// 读取当前壁纸（设置页预览 & 悬浮窗初始化）
ipcMain.handle("get-current-image", () => getCurrentImage());

// 启动时识别当前桌面壁纸：让第一次“换壁纸”不会抽到同一张，
// 也让悬浮窗一打开就知道该评价哪一张（而不是提示“还没有壁纸”）
async function initCurrentImage() {
  try {
    const wp = await getWallpaperModule();
    const current = (await wp.getWallpaper() || "").trim();
    if (!current) return;
    // 路径大小写不敏感匹配（盘符大小写可能不同）
    const row = dbQuery("SELECT id FROM images WHERE LOWER(path) = LOWER(?)", [current]);
    if (row) {
      setCurrentImageId(row.id);
      console.log("[当前壁纸] 已识别启动时的桌面壁纸, id =", row.id);
    } else {
      console.log("[当前壁纸] 桌面壁纸不在图库里, id 置空:", current);
    }
  } catch (e) {
    console.log("[当前壁纸] 启动时识别失败:", e.message);
  }
}

// 临时文件清理：超过 temp_clean_interval 天的 temp 文件删除，并清掉对应记录
function cleanTempFiles() {
  const days = parseInt(getSetting("temp_clean_interval", "7")) || 0;
  if (days <= 0) return; // 0 = 从不清理
  const tempDir = path.join(dataRoot, "temp");
  if (!fs.existsSync(tempDir)) return;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(tempDir)) {
    const p = path.join(tempDir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      fs.unlinkSync(p);
      dbExec("DELETE FROM images WHERE path = ?", [p]);
      removed++;
    } catch (e) {
      console.error("[清理] 删除临时文件失败:", p, e.message);
    }
  }
  if (removed > 0) {
    saveDatabase();
    console.log(`[清理] 已清理 ${removed} 个临时文件（保留 ${days} 天）`);
  }
}

// ==================== 风格随机池：从源头保证壁纸风格多样化 ====================
// 背景：只靠 LLM“随机生成”会自我收敛（同一主题反复出现），而旧版把整段提示词
// 碎片当关键字回喂给 LLM，形成“越生成越雷同”的死循环。现改为：每次生成前从
// 各维度随机池抽签组成“风格种子”，强制 LLM 在约束内创作，确保风格互不相同。

const STYLE_DIMENSIONS = {
  // 艺术风格
  style: [
    "minimalist flat design", "impressionist oil painting", "cyberpunk neon",
    "watercolor painting", "3D isometric render", "low poly art",
    "vaporwave retro-futurism", "Chinese ink wash painting", "ukiyo-e woodblock print",
    "pixel art", "abstract geometric art", "surrealism",
    "cinematic photorealism", "dark gothic art", "vintage analog film",
    "claymation style", "glass morphism render", "art nouveau poster",
    "double exposure photography", "paper cut art", "steampunk",
    "fantasy concept art", "bauhaus poster design", "risograph print",
  ],
  // 主题题材
  subject: [
    "majestic mountains", "deep ocean underwater world", "nebula and galaxies in space",
    "wild animals in nature", "futuristic city skyline", "ancient architecture",
    "flower fields in bloom", "desert sand dunes", "misty forest",
    "glaciers and ice landscapes", "waterfalls and rivers", "abstract texture patterns",
    "mythical creatures", "starry night sky", "coastal cliffs and lighthouse",
    "tropical island beach", "autumn countryside", "cherry blossoms",
    "birds in flight", "hot air balloons in the sky", "rainy neon city street",
    "volcanic landscape", "aurora over snowy wilderness", "zen garden",
  ],
  // 色调
  palette: [
    "warm sunset orange and gold", "cool arctic blue and white", "black and gold high contrast",
    "pastel macaron colors", "monochrome minimalist", "neon purple and cyan gradient",
    "earthy natural tones", "morandi muted tones", "vivid saturated rainbow",
    "deep emerald green", "crimson red and charcoal", "soft cream and beige",
    "teal and orange duotone", "iridescent holographic",
  ],
  // 光照
  lighting: [
    "golden hour sunlight", "blue hour twilight", "backlit silhouette",
    "soft diffused light", "neon glow", "moonlight",
    "aurora glow", "god rays through clouds", "bioluminescent glow",
    "warm candlelight", "dramatic chiaroscuro", "overcast soft light",
  ],
  // 构图
  composition: [
    "centered symmetrical", "rule of thirds", "minimalist negative space",
    "strong leading lines", "framed by foreground", "macro close-up",
    "ultra wide panorama", "aerial top-down", "low angle looking up",
    "layered foreground midground background",
  ],
  // 氛围
  mood: [
    "peaceful and healing", "epic and majestic", "mysterious and dreamlike",
    "energetic and vibrant", "serene and meditative", "cozy and nostalgic",
    "ethereal and otherworldly", "playful and whimsical", "lonely and vast",
    "dramatic and intense",
  ],
};

// 最近用过的抽签结果（进程内记录），抽签时避开，防止连续生成撞车
const recentStylePicks = [];
const RECENT_STYLE_MAX = 60;

// 从某个维度随机抽一项，尽量避开最近用过的
function pickFromPool(dim) {
  const pool = STYLE_DIMENSIONS[dim];
  const recent = new Set(
    recentStylePicks
      .filter((s) => s.startsWith(dim + "::"))
      .map((s) => s.slice(dim.length + 2)),
  );
  const fresh = pool.filter((v) => !recent.has(v));
  const candidates = fresh.length > 0 ? fresh : pool;
  const value = candidates[Math.floor(Math.random() * candidates.length)];
  recentStylePicks.push(dim + "::" + value);
  if (recentStylePicks.length > RECENT_STYLE_MAX) {
    recentStylePicks.splice(0, recentStylePicks.length - RECENT_STYLE_MAX);
  }
  return value;
}

// 抽一套完整的风格种子（每个维度各一项）
function buildStyleSeed() {
  const seed = {};
  for (const dim of Object.keys(STYLE_DIMENSIONS)) {
    seed[dim] = pickFromPool(dim);
  }
  console.log("[风格种子]", JSON.stringify(seed));
  return seed;
}

// 探索/利用：决定本次“主题”是否参考历史喜好
// - 以 style_explore_rate（默认 0.5）的概率完全随机探索 → 收集新关键字的喜好数据
// - 否则从历史高分关键字里随机抽 1~2 个融入（随机抽而不是固定取前几名，避免单主题垄断）
// 历史关键字超过 40 字符的视为旧版提取出的句子碎片，直接忽略不参与
function pickSubjectHint() {
  let rows = [];
  try {
    rows = dbQueryAll(
      "SELECT keyword, score FROM keywords WHERE length(keyword) <= 40 ORDER BY score DESC LIMIT 10",
    );
  } catch (e) {
    rows = [];
  }
  if (rows.length === 0) return null;
  const exploreRate = parseFloat(getSetting("style_explore_rate", "0.5"));
  if (Number.isFinite(exploreRate) && Math.random() < exploreRate) return null;
  const shuffled = rows.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 2).map((r) => r.keyword).join(" and ");
}

// 组装发给 LLM 的提示词生成请求（方法 A / 方法 B 共用）
function buildPromptRequest(seed, subjectHint) {
  const lines = [
    "Generate ONE detailed English wallpaper prompt.",
    "You MUST strictly follow these randomly chosen design constraints:",
    `- Art style: ${seed.style}`,
    `- Subject: ${seed.subject}`,
    `- Color palette: ${seed.palette}`,
    `- Lighting: ${seed.lighting}`,
    `- Composition: ${seed.composition}`,
    `- Mood: ${seed.mood}`,
  ];
  if (subjectHint) {
    lines.push(`- Naturally blend in these elements the user liked before: ${subjectHint}`);
  }
  lines.push(
    "Describe the scene, colors, layout and atmosphere in ONE flowing English paragraph.",
    "Do NOT use markdown, headings, bullet points or quotes.",
    "Do NOT add any preamble like \"Here is\" or any explanation.",
    "Output ONLY the prompt text, then on a new final line output \"KEYWORDS:\" followed by 6 short English tags (1-3 words each) covering style, subject, palette and mood.",
  );
  return lines.join("\n");
}

// ==================== 接口 Profile（ADR-011） ====================

function profileSettingKey(role) {
  return role === "llm" ? "llm_profile" : "image_profile";
}

// 读取并收敛成完整 profile；没存过时返回当前模板的默认值
function getProfile(role) {
  let raw = "";
  try {
    raw = getSetting(profileSettingKey(role));
  } catch (e) {
    raw = "";
  }
  return adapters.normalizeProfile(role, raw || { template: adapters.templateIds(role)[0] });
}

function saveProfile(role, profile) {
  const normalized = adapters.normalizeProfile(role, profile || {});
  setSetting(profileSettingKey(role), JSON.stringify(normalized));
  // 用户刚改完配置，之前的失败退避不再有意义
  resetPreloadBackoff();
  return normalized;
}

function profileTimeoutMs(profile, settingKey, defaultSec) {
  const own = Number(profile && profile.timeoutSec);
  if (own > 0) return own * 1000;
  try {
    return getTimeoutSetting(settingKey, defaultSec);
  } catch (e) {
    return defaultSec * 1000;
  }
}

// 从各种错误响应里抠出人能看懂的一句话
function getErrorMessageFromResponse(data) {
  if (data === undefined || data === null) return "";
  if (Buffer.isBuffer(data)) return getErrorMessageFromResponse(data.toString("utf8"));
  if (typeof data === "string") {
    const text = data.trim();
    if (!text) return "";
    try {
      return getErrorMessageFromResponse(JSON.parse(text));
    } catch (e) {
      return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300);
    }
  }
  if (typeof data !== "object") return String(data).slice(0, 300);
  const candidates = [
    data.error && (data.error.message || data.error.msg || data.error),
    data.message,
    data.msg,
    data.detail,
    data.error_message,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 300);
  }
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch (e) {
    return "";
  }
}

function describeApiError(err) {
  if (!err) return "未知错误";
  if (err.isApiError && err.message) return redactSecrets(err.message);
  const status = err.response && err.response.status;
  if (status) {
    const detail = getErrorMessageFromResponse(err.response.data);
    const suffix = detail ? `：${detail}` : "";
    return redactSecrets(`接口返回 ${status}${suffix}`);
  }
  const code = err.code || "";
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(err.message || "")) {
    return "请求超时";
  }
  if (code === "ECONNREFUSED") return "无法连接接口地址（连接被拒绝）";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "接口域名解析失败，请检查地址";
  if (code === "ECONNRESET") return "连接被重置";
  if (code === "ERR_NETWORK") return "网络不可用";
  if (code === "ERR_CANCELED") return "请求已取消";
  return redactSecrets((err.message || String(err)).slice(0, 300));
}

function reportApiError(role, message, err) {
  console.error(`[接口] ${message}`, err && err.stack ? err.stack : "");
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("api-error", {
      role,
      message,
      time: Date.now(),
    });
  }
}

// 所有 HTTP 请求的统一入口：超时 / 网络 / 5xx 自动重试一次，4xx 直接抛
async function apiRequest(config, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000;
  const retry = options.retry !== false;
  const run = () =>
    axios.request({
      method: "GET",
      ...config,
      timeout: timeoutMs,
    });

  try {
    return await run();
  } catch (err) {
    if (retry && adapters.isRetryableError(err)) {
      notifyProgress(`请求失败，正在重试一次：${describeApiError(err)}`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return await run();
    }
    throw err;
  }
}

// 兼容 JSON 与二进制响应：二进制会包成 { __binary, contentType }
// 具体实现放在 lib/adapters.js，便于 test/ 离线验证
function parseResponseBody(resp) {
  return adapters.parseResponseBody(resp);
}

async function downloadImage(url, profile, timeoutMs) {
  // “下载时携带鉴权”同时带上自定义请求头与认证头（部分图床要求同一套头）
  const headers = profile.downloadWithAuth
    ? { ...(profile.headers || {}), ...adapters.authHeaders(profile) }
    : {};
  const resp = await apiRequest(
    { url, method: "GET", headers, responseType: "arraybuffer" },
    { timeoutMs },
  );
  const contentType = (resp.headers && resp.headers["content-type"]) || "";
  const buffer = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data || []);
  if (buffer.length === 0) throw new Error("下载到的图片为空");
  return { buffer, contentType };
}

// 按 Content-Type / 文件魔数写文件，不再一律 .png
function writeImageFile(saveDir, buffer, contentType) {
  if (!buffer || buffer.length === 0) throw new Error("图片内容为空");
  const ext = adapters.guessImageExtension(contentType, buffer);
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filePath = path.join(saveDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function materializeImage(image, saveDir, profile, timeoutMs) {
  if (image.kind === "url") {
    notifyProgress("图片生成成功，正在下载...");
    const downloaded = await downloadImage(image.value, profile, timeoutMs);
    return writeImageFile(saveDir, downloaded.buffer, downloaded.contentType);
  }
  if (image.kind === "base64") {
    notifyProgress("图片生成成功，正在解码 base64...");
    return writeImageFile(saveDir, Buffer.from(image.value, "base64"), "");
  }
  if (image.kind === "bytes") {
    return writeImageFile(saveDir, image.value, image.contentType || "");
  }
  throw new Error("无法识别的图片返回格式");
}

// 异步任务轮询
async function pollImage(profile, taskId, timeoutMs, quiet) {
  const poll = profile.poll || {};
  const intervalMs = Math.max(1000, Number(poll.intervalSec || 5) * 1000);
  const totalMs = Math.max(10000, Number(poll.timeoutSec || 300) * 1000);
  const deadline = Date.now() + totalMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const req = adapters.planPollRequest(profile, taskId);
    const resp = await apiRequest(req, { timeoutMs: Math.min(timeoutMs, 60000) });
    const data = parseResponseBody(resp);
    const step = adapters.pollStep(profile, data);
    if (step.state === "success") return step.image;
    if (step.state === "failed") {
      throw new Error(`生成任务失败（状态：${step.status || "unknown"}）`);
    }
    if (!quiet) {
      notifyProgress(`图片生成中（状态：${step.status || "等待中"}）...`);
    }
  }
  throw new Error(`等待图片生成超时（${Math.round(totalMs / 1000)} 秒）`);
}

// 调用 LLM 生成提示词正文（方法 A / 方法 B 共用），返回原始文本
async function callPromptLLM(userContent) {
  const profile = getProfile("llm");
  if (!profile.url) {
    throw new Error("请先在「模型接入」里填写 LLM 接口地址");
  }

  const messages = [
    {
      role: "system",
      content:
        "你是一个壁纸提示词生成助手。严格遵守用户给出的风格约束，只输出提示词正文和 KEYWORDS 行，不要输出客套话或解释。每次都要给出与之前完全不同的创意。",
    },
    { role: "user", content: userContent },
  ];

  const req = adapters.planRequest("llm", profile, { messages });
  const timeoutMs = profileTimeoutMs(profile, "llm_timeout", 120);

  try {
    const resp = await apiRequest(req, { timeoutMs });
    const data = parseResponseBody(resp);
    return adapters.extractText(data, profile);
  } catch (err) {
    const message = `LLM 调用失败：${describeApiError(err)}`;
    reportApiError("llm", message, err);
    throw new Error(message);
  }
}

// 生成提示词（方法 B：库空时的迫切生成）
// 返回 { prompt: 清理后的提示词, keywords: 种子标签 + 解析出的关键字 }
async function generatePrompt() {
  notifyProgress("正在调用 LLM 生成提示词...");
  const seed = buildStyleSeed();
  const subjectHint = pickSubjectHint();
  const raw = await callPromptLLM(buildPromptRequest(seed, subjectHint));
  const keywords = dedupeKeywords([...Object.values(seed), ...parsePromptKeywords(raw)]);
  const prompt = cleanPromptForImage(raw);
  notifyProgress(`提示词生成完成（风格：${seed.style}）: ${prompt.substring(0, 80)}...`);
  return { prompt, keywords };
}

// 文生图（调用用户配置的服务）
async function generateImage(prompt) {
  const profile = getProfile("image");
  const saveDir = getSetting("image_dir") || path.join(dataRoot, "images");

  if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
    console.log("[预生成] 创建图片保存目录:", saveDir);
  }

  if (!profile.url) {
    throw new Error("请先在「模型接入」里填写文生图接口地址");
  }

  const wallpaperDisplaySetting = getSetting("wallpaper_display", "primary");
  const targetRatio = getDisplayRatio(wallpaperDisplaySetting);
  console.log(
    `[预生成] 文生图模板: ${profile.template}, 显示器: ${wallpaperDisplaySetting}, 长宽比: ${targetRatio}`,
  );

  const req = adapters.planRequest("image", profile, {
    prompt,
    ratio: targetRatio,
  });
  const timeoutMs = profileTimeoutMs(profile, "image_timeout", 180);

  notifyProgress("正在调用文生图 API...");

  const startedAt = Date.now();
  try {
    const resp = await apiRequest(
      { ...req, responseType: "arraybuffer" },
      { timeoutMs },
    );
    console.log(`[预生成] 文生图 API 已响应，耗时 ${Date.now() - startedAt}ms`);

    const data = parseResponseBody(resp);
    let image;
    if (data && data.__binary) {
      image = { kind: "bytes", value: data.__binary, contentType: data.contentType };
    } else {
      console.log(
        "[预生成] API 响应摘要:",
        JSON.stringify(data).slice(0, 300),
      );
      image = adapters.extractImage(data, profile);
    }

    if (image.kind === "task") {
      notifyProgress("已提交生成任务，等待结果...");
      image = await pollImage(profile, image.taskId, timeoutMs);
    }

    const filePath = await materializeImage(image, saveDir, profile, timeoutMs);
    console.log("[预生成] 图片文件已写入:", filePath);
    notifyProgress("图片已保存:" + filePath);
    return filePath;
  } catch (err) {
    const message = `文生图调用失败：${describeApiError(err)}`;
    reportApiError("image", message, err);
    throw new Error(message);
  }
}

// 测试连接：LLM 发一条极短消息；文生图会真实生成一张（不保存），用于验证鉴权与解析路径
async function testConnection(role, rawProfile) {
  const profile = adapters.normalizeProfile(
    role,
    rawProfile || getProfile(role),
  );
  const start = Date.now();
  const result = (extra) => ({
    success: extra.success,
    elapsedMs: Date.now() - start,
    detail: extra.detail || "",
    status: extra.status || 0,
    errorCode: extra.errorCode || "",
  });

  try {
    if (!profile.url) throw new Error("接口地址为空");

    if (role === "llm") {
      const req = adapters.planRequest("llm", profile, {
        messages: [{ role: "user", content: "Reply with the single word OK." }],
      });
      const resp = await apiRequest(req, { timeoutMs: 30000, retry: false });
      const text = adapters.extractText(parseResponseBody(resp), profile);
      return result({ success: true, detail: text.slice(0, 200) });
    }

    const req = adapters.planRequest("image", profile, {
      prompt: "a tiny blue circle on a plain white background, flat icon",
      ratio: "16:9",
    });
    const timeoutMs = profileTimeoutMs(profile, "image_timeout", 180);
    const resp = await apiRequest(
      { ...req, responseType: "arraybuffer" },
      { timeoutMs, retry: false },
    );
    const data = parseResponseBody(resp);
    let image =
      data && data.__binary
        ? { kind: "bytes", value: data.__binary, contentType: data.contentType }
        : adapters.extractImage(data, profile);
    if (image.kind === "task") {
      image = await pollImage(profile, image.taskId, timeoutMs, true);
    }

    let detail = "";
    if (image.kind === "url") {
      detail = `返回图片 URL：${String(image.value).slice(0, 150)}`;
    } else if (image.kind === "base64") {
      detail = `返回 base64 图片（约 ${Math.round((image.value.length * 3) / 4 / 1024)} KB）`;
    } else {
      detail = `返回二进制图片（约 ${Math.round(image.value.length / 1024)} KB）`;
    }
    return result({ success: true, detail });
  } catch (err) {
    return result({
      success: false,
      detail: describeApiError(err),
      status: (err.response && err.response.status) || 0,
      errorCode: err.code || "",
    });
  }
}


// 清理提示词再发给文生图：去掉 KEYWORDS 行、开场白和 markdown 符号，
// 避免图片模型把 "Here is..." 之类的文字渲染进画面
function cleanPromptForImage(text) {
  const cleaned = String(text || "")
    .replace(/KEYWORDS:.*$/im, "")
    .split("\n")
    // 过滤常见开场白/解释性行
    .filter(
      (line) =>
        !/^\s*(here (is|'s)|sure|certainly|of course|below is|i've|i have)\b/i.test(line),
    )
    .join("\n")
    .replace(/\*\*|__/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return cleaned || String(text || "").trim();
}

// 从提示词提取关键字：优先取 LLM 按约定输出的 KEYWORDS: 行（短标签，最干净）；
// 没有时退回旧规则（按标点分割取前 5），但过滤句子碎片和开场白
function parsePromptKeywords(text) {
  const src = String(text || "");
  const m = src.match(/KEYWORDS:\s*(.+)/i);
  if (m) {
    const tags = m[1]
      .split(/[,，;；、|]/)
      .map((s) => s.replace(/[*#">]/g, "").trim())
      .filter((s) => s.length > 0 && s.length <= 40);
    if (tags.length >= 3) return tags.slice(0, 8);
  }
  return src
    .split(/[,，。;；\n]/)
    .map((s) => s.replace(/[*#">]/g, "").trim())
    .filter((s) => s.length > 2 && s.length <= 40)
    .filter((s) => !/^(here|sure|certainly|prompt|keywords)\b/i.test(s))
    .slice(0, 5);
}

// 关键字去重合并（种子标签 + 解析标签），限制总数避免关键字表膨胀
function dedupeKeywords(tags) {
  const seen = new Set();
  const out = [];
  for (const t of tags || []) {
    const key = String(t).trim().toLowerCase();
    if (key && key.length <= 40 && !seen.has(key)) {
      seen.add(key);
      out.push(String(t).trim());
    }
  }
  return out.slice(0, 12);
}

// 保存图片记录和关键字权重
function saveImageRecord(imagePath, prompt, keywords) {
  const now = new Date().toISOString();
  dbExec(
    "INSERT INTO images (path, prompt, keywords, status, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [imagePath, prompt, JSON.stringify(keywords), "normal", 100, now],
  );

  // 初始化关键字（分数为 0，等用户操作后再调整）
  keywords.forEach((kw) => {
    const row = dbQuery("SELECT score FROM keywords WHERE keyword = ?", [kw]);
    if (!row) {
      dbExec(
        "INSERT INTO keywords (keyword, score, updated_at) VALUES (?, ?, ?)",
        [kw, 0, now],
      );
    }
  });
  saveDatabase();
}

// 按 weight 加权随机挑一张（weight 越大越容易被抽到）
function weightedPick(rows) {
  const weightOf = (r) => Math.max(1, Number(r.weight) || 0);
  const total = rows.reduce((sum, r) => sum + weightOf(r), 0);
  let rnd = Math.random() * total;
  for (const r of rows) {
    rnd -= weightOf(r);
    if (rnd <= 0) return r;
  }
  return rows[rows.length - 1];
}

// 换壁纸方式设置项：random = 随机（加权抽取），sequential = 按顺序（生成先后依次切换）
function getChangeMode() {
  try {
    return getSetting("change_mode", "random") === "sequential"
      ? "sequential"
      : "random";
  } catch (e) {
    return "random";
  }
}

// 从预生成库挑一张可直接上墙的图（方案 §7：有待选图片 → 从预生成库取一张）
// - 只排除 disliked（liked 也参与抽取，见方案 §4.3）
// - 排除当前正显示的这张，避免点了“换壁纸”桌面却没变化
// - 排除文件已不存在的记录（用户手动删过图）
// - 顺序模式：按 id（生成先后）取当前这张之后的一张，到尾部后回到开头
// - 随机模式：优先取从没展示过的，其次按 weight 加权随机
function pickFromLibrary(excludeId) {
  if (!dbReady) return null;
  const rows = dbQueryAll(
    'SELECT * FROM images WHERE status <> "disliked" ORDER BY weight DESC, RANDOM()',
  );
  const usable = rows.filter(
    (r) => r.id !== excludeId && r.path && fs.existsSync(r.path),
  );
  if (usable.length === 0) return null;

  if (getChangeMode() === "sequential") {
    const seq = usable.slice().sort((a, b) => a.id - b.id);
    const after = excludeId ? seq.find((r) => r.id > excludeId) : null;
    return after || seq[0];
  }

  const fresh = usable.filter((r) => !r.last_shown);
  return weightedPick(fresh.length > 0 ? fresh : usable);
}

// 换壁纸主流程：预生成库优先，库空了才现场生成（方法 B）
async function changeWallpaper() {
  if (isChangingWallpaper) {
    return { success: false, error: "正在生成壁纸，请稍候再试" };
  }
  isChangingWallpaper = true;
  const startTime = Date.now();
  notifyProgress("=== 开始换壁纸 ===");
  try {
    // 1）有待选图片 → 直接从预生成库取一张，秒出
    const fromLib = pickFromLibrary(currentImageId);
    if (fromLib) {
      notifyProgress("预生成库有待选图片，直接取一张上墙");
      await setWallpaper(fromLib.path);
      const elapsed = Date.now() - startTime;
      notifyProgress(`=== 换壁纸完成（来自预生成库），耗时 ${elapsed}ms ===`);
      return {
        success: true,
        fromLibrary: true,
        imagePath: fromLib.path,
        prompt: fromLib.prompt,
        elapsed,
      };
    }

    // 2）无待选图片 → 迫切生成（方法 B：先生成图片，再提取关键字）
    notifyProgress("预生成库没有可用图片，现场生成（方法 B）...");
    const { prompt, keywords } = await generatePrompt();
    const imagePath = await generateImage(prompt);
    notifyProgress("正在保存到数据库...");
    saveImageRecord(imagePath, prompt, keywords);
    await setWallpaper(imagePath);
    const elapsed = Date.now() - startTime;
    notifyProgress(`=== 换壁纸完成，耗时 ${elapsed}ms ===`);
    return { success: true, imagePath, prompt, elapsed };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`换壁纸失败(${elapsed}ms):`, err.message);
    return { success: false, error: err.message, elapsed };
  } finally {
    isChangingWallpaper = false;
  }
}

// 喜欢图片（悬浮按钮调用，返回结果给前端做反馈）
ipcMain.handle("like-image", (event, imageId) => rateImage(imageId, "liked"));

// 不喜欢图片（标记 + 关键字 -1 + 自动换下一张）
ipcMain.handle("dislike-image", (event, imageId) => rateImage(imageId, "disliked"));

// 忽略图片（权重减少）
ipcMain.handle("ignore-image", (event, imageId) => {
  if (!dbReady) return;
  dbExec("UPDATE images SET weight = weight - 1 WHERE id = ?", [imageId]);
  saveDatabase();
});

// 读写设置
ipcMain.handle("get-setting", (event, key) => getSetting(key));
ipcMain.handle("set-setting", (event, key, value) => setSetting(key, value));

// ==================== 接口 Profile（ADR-011） ====================

// 设置页渲染下拉框/高级区所需元数据
ipcMain.handle("get-profile-meta", () => ({
  templates: {
    llm: adapters.listTemplates("llm"),
    image: adapters.listTemplates("image"),
  },
  authTypes: adapters.AUTH_TYPES,
}));

// 切换模板时填充默认值
ipcMain.handle("get-profile-defaults", (event, role, template) =>
  adapters.defaultProfile(role, template),
);

ipcMain.handle("get-profiles", () => ({
  llm: getProfile("llm"),
  image: getProfile("image"),
}));

ipcMain.handle("save-profile", (event, role, profile) => {
  if (role !== "llm" && role !== "image") {
    return { success: false, error: "未知的配置角色" };
  }
  try {
    return { success: true, profile: saveProfile(role, profile) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("test-connection", (event, role, profile) =>
  testConnection(role, profile),
);

// 获取壁纸生成显示器设置
ipcMain.handle("get-wallpaper-display", () => {
  return getSetting("wallpaper_display", "primary");
});

// 设置壁纸生成显示器
ipcMain.handle("set-wallpaper-display", (event, value) => {
  setSetting("wallpaper_display", value);
  return { success: true };
});

// 获取所有显示器列表（用于悬浮按钮多显示器选择）
ipcMain.handle("get-displays", () => {
  return screen.getAllDisplays().map((d, i) => ({
    index: i,
    label: `${d.bounds.width}x${d.bounds.height}${d.isPrimary ? '（主显示器）' : ''}`,
    bounds: d.bounds,
    workArea: d.workArea,
    // 添加长宽比信息
    ratio: calculateAspectRatio(d.bounds.width, d.bounds.height),
  }));
});

// 根据屏幕分辨率计算最佳长宽比
function calculateAspectRatio(width, height) {
  const ratio = width / height;
  
  // 根据常见的屏幕比例返回合适的ratio参数
  if (Math.abs(ratio - 16/9) < 0.1) {
    return "16:9";  // 大多数现代显示器和电视
  } else if (Math.abs(ratio - 21/9) < 0.1 || Math.abs(ratio - 18/9) < 0.1) {
    return "21:9";  // 超宽屏显示器
  } else if (Math.abs(ratio - 16/10) < 0.1) {
    return "16:10"; // 部分显示器和笔记本电脑
  } else if (Math.abs(ratio - 4/3) < 0.1) {
    return "4:3";   // 较老的显示器
  } else if (Math.abs(ratio - 3/2) < 0.1) {
    return "3:2";   // Surface Studio等设备
  } else if (Math.abs(ratio - 1/1) < 0.1) {
    return "1:1";   // 正方形屏幕（如部分手机或特殊显示器）
  } else {
    // 对于不常见的比例，使用最接近的标准比例
    return ratio > 1 ? "16:9" : "9:16"; // 默认横向或纵向
  }
}

// 获取指定显示器的长宽比
function getDisplayRatio(displayIndex = null) {
  const allDisplays = screen.getAllDisplays();
  
  // 如果没有指定显示器索引，使用主显示器
  let display;
  if (displayIndex === null || displayIndex === "primary") {
    display = allDisplays.find(d => d.isPrimary) || allDisplays[0];
  } else if (displayIndex === "current") {
    // 获取当前壁纸所在的显示器
    const currentWallpaper = getCurrentImage();
    if (currentWallpaper && currentWallpaper.path) {
      // 这里简化处理，实际应该根据壁纸位置确定显示器
      // 暂时使用主显示器
      display = allDisplays.find(d => d.isPrimary) || allDisplays[0];
    } else {
      display = allDisplays.find(d => d.isPrimary) || allDisplays[0];
    }
  } else {
    // 使用指定的显示器索引
    display = allDisplays[displayIndex] || allDisplays[0];
  }
  
  return calculateAspectRatio(display.bounds.width, display.bounds.height);
}

// 获取当前显示器的长宽比（保持向后兼容）
function getCurrentDisplayRatio() {
  return getDisplayRatio();
}

// 获取主题色设置
ipcMain.handle("get-theme", () => {
  return {
    // 主界面颜色
    mainColor: getSetting("theme_main_color", "#007acc"),
    bgColor: getSetting("theme_bg_color", "#f5f5f5"),
    textColor: getSetting("theme_text_color", "#333333"),
    textSecondary: getSetting("theme_text_secondary", "#666666"),
    borderColor: getSetting("theme_border_color", "#dddddd"),
    preset: getSetting("theme_preset", "default"),
    // 悬浮按钮颜色
    btnLike: getSetting("theme_btn_like", "#4caf50"),
    btnDislike: getSetting("theme_btn_dislike", "#f44336"),
    btnSettings: getSetting("theme_btn_settings", "#2196f3"),
    borderRadius: getSetting("theme_border_radius", "16px"),
    position: getSetting("float_position", "right-top"),
    hideDelay: parseInt(getSetting("float_hide_delay", "1500")),
  };
});

// 保存主题色设置
ipcMain.handle("set-theme", (event, theme) => {
  const updates = {
    theme_main_color: theme.mainColor,
    theme_bg_color: theme.bgColor,
    theme_card_bg: theme.cardBg,
    theme_text_color: theme.textColor,
    theme_text_secondary: theme.textSecondary,
    theme_border_color: theme.borderColor,
    theme_preset: theme.preset,
    theme_btn_like: theme.btnLike,
    theme_btn_dislike: theme.btnDislike,
    theme_btn_settings: theme.btnSettings,
    theme_border_radius: theme.borderRadius,
    float_hide_delay: String(theme.hideDelay || 1500),
  };
  // 只有显式传了位置才覆盖（设置界面没有位置选项时不能把贴边方向冲掉）
  if (theme.position) {
    updates.float_position = theme.position;
  }
  for (const [key, value] of Object.entries(updates)) {
    setSetting(key, value);
  }
  // 通知悬浮窗口主题已变更，同步更新颜色
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.webContents.send("theme-changed", theme);
  }
  return { success: true };
});

// ==================== 预生成图片库（方法 A：先关键字→再提示词→再图片） ====================

// 预生成库配置
let preloadConfig = {
  enabled: true,
  maxCount: 10, // 最多保留 10 张
  idleMinutes: 5, // 空闲多少分钟后开始预生成
  isGenerating: false, // 是否正在生成中
  lastFailTime: 0, // 上次失败时间戳
  failCount: 0, // 连续失败次数（成功后清零）
  retryDelayMs: 0, // 当前退避时长
  pauseUntil: 0, // 退避结束时间戳
  lastError: "", // 最近一次失败原因（给设置页显示）
};

// 失败退避：60 秒 → 5 分钟 → 15 分钟（ADR-011）
const PRELOAD_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

// 启动时从 settings 恢复预生成配置。
// 之前只靠界面保存时调用 set-preload-config，重启后会退回默认值（界面显示已关闭、后台仍在跑）。
function loadPreloadConfig() {
  try {
    const enabledVal = getSetting("preload_enabled");
    preloadConfig.enabled = enabledVal === "" ? true : enabledVal !== "false";
    preloadConfig.maxCount = parseInt(getSetting("preload_max"), 10) || 10;
    preloadConfig.idleMinutes = parseInt(getSetting("preload_idle"), 10) || 5;
  } catch (e) {
    console.error("[预生成] 读取配置失败:", e.message);
  }
}

function notifyPreloadStatus() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("preload-status", {
      isGenerating: preloadConfig.isGenerating,
      failCount: preloadConfig.failCount,
      retryDelayMs: preloadConfig.retryDelayMs,
      pauseUntil: preloadConfig.pauseUntil,
      lastError: preloadConfig.lastError,
    });
  }
}

function schedulePreloadBackoff(error) {
  const index = Math.min(preloadConfig.failCount, PRELOAD_BACKOFF_MS.length - 1);
  const delay = PRELOAD_BACKOFF_MS[index];
  preloadConfig.failCount += 1;
  preloadConfig.retryDelayMs = delay;
  preloadConfig.pauseUntil = Date.now() + delay;
  preloadConfig.lastFailTime = Date.now();
  preloadConfig.lastError = String(error || "未知错误");
  console.log(
    `[预生成] 失败，${Math.round(delay / 1000)} 秒后再试：${preloadConfig.lastError}`,
  );
  notifyPreloadStatus();
}

function resetPreloadBackoff() {
  preloadConfig.failCount = 0;
  preloadConfig.retryDelayMs = 0;
  preloadConfig.pauseUntil = 0;
  preloadConfig.lastError = "";
  notifyPreloadStatus();
}

// 空闲检测（通过 IPC 从渲染进程接收用户活动）
let lastActivityTime = Date.now();
let idleTimer = null;

function resetIdleTimer() {
  lastActivityTime = Date.now();
}

function getIdleMinutes() {
  return (Date.now() - lastActivityTime) / 1000 / 60;
}

// 检查是否应该开始预生成
function shouldPreload() {
  if (!preloadConfig.enabled) return false;
  if (preloadConfig.pauseUntil > Date.now()) return false;
  return getIdleMinutes() >= preloadConfig.idleMinutes;
}

// 获取当前预生成库图片数量（status='normal' 且未被显示过的，作为候选库）
function getPreloadCount() {
  const row = dbQuery(
    'SELECT COUNT(*) as cnt FROM images WHERE status = "normal"',
  );
  return row ? row.cnt : 0;
}

// 方法 A 生成：先关键字 → 再提示词 → 再图片（用于预生成）
async function generateImageMethodA() {
  const stepStart = () => Date.now();
  const stepLog = (name, start) =>
    console.log(`[预生成] ${name} 耗时 ${Date.now() - start}ms`);

  try {
    console.log("[预生成] ===== 开始生成单张图片 =====");

    // 步骤 1：抽风格种子 + 决定是否参考历史喜好（探索/利用）
    const s1 = stepStart();
    const seed = buildStyleSeed();
    const subjectHint = pickSubjectHint();
    stepLog("步骤1/4 抽取风格种子", s1);

    // 步骤 2：生成提示词（LLM）
    const s2 = stepStart();
    const raw = await callPromptLLM(buildPromptRequest(seed, subjectHint));
    const prompt = cleanPromptForImage(raw);
    stepLog("步骤2/4 生成提示词", s2);
    console.log("[预生成] 提示词:", prompt.substring(0, 100) + "...");

    // 步骤 3：生成图片（文生图）
    const s3 = stepStart();
    console.log("[预生成] 步骤3/4 调用文生图 API...");
    const imagePath = await generateImage(prompt);
    stepLog("步骤3/4 生成图片文件", s3);
    console.log("[预生成] 图片文件路径:", imagePath);

    // 验证文件是否真正写入磁盘
    const fs = require("fs");
    if (fs.existsSync(imagePath)) {
      const stat = fs.statSync(imagePath);
      console.log(`[预生成] 文件已写入磁盘，大小: ${stat.size} 字节`);
    } else {
      throw new Error("图片文件写入后不存在，路径: " + imagePath);
    }

    // 步骤 4：保存到数据库（种子标签 + 解析出的关键字一起入库，参与喜好统计）
    const s4 = stepStart();
    const keywords = dedupeKeywords([...Object.values(seed), ...parsePromptKeywords(raw)]);
    saveImageRecord(imagePath, prompt, keywords);
    stepLog("步骤4/4 保存数据库", s4);

    const totalTime = Date.now() - stepStart();
    console.log(`[预生成] ===== 单张图片生成完成，总耗时 ${totalTime}ms =====`);
    return { success: true, imagePath, prompt, keywords };
  } catch (err) {
    console.error("[预生成] 单张生成失败:", err.message);
    console.error("[预生成] 错误堆栈:", err.stack);
    return { success: false, error: err.message };
  }
}

// 预生成主循环
async function preloadLoop() {
  if (!shouldPreload()) return;

  preloadConfig.isGenerating = true;
  notifyPreloadStatus();
  console.log("[预生成] 开始后台预生成图片...");

  try {
    while (getPreloadCount() < preloadConfig.maxCount && shouldPreload()) {
      console.log(
        `[预生成] 当前库存：${getPreloadCount()}/${preloadConfig.maxCount}`,
      );
      const result = await generateImageMethodA();
      if (result.success) {
        console.log(
          `[预生成] 已生成一张，当前库存：${getPreloadCount()}/${preloadConfig.maxCount}`,
        );
        if (preloadConfig.failCount > 0) resetPreloadBackoff();
      } else {
        // 失败后按 60s → 5min → 15min 退避，由 shouldPreload() 拦截下次尝试
        schedulePreloadBackoff(result.error);
        break;
      }
    }
  } finally {
    preloadConfig.isGenerating = false;
    notifyPreloadStatus();
  }
}

// 空闲检查定时器（每 30 秒检查一次是否需要预生成）
let preloadCheckTimer = null;
function startPreloadCheck() {
  if (preloadCheckTimer) clearInterval(preloadCheckTimer);
  preloadCheckTimer = setInterval(() => {
    preloadLoop().catch(console.error);
  }, 30000);
}

// 获取下一张壁纸候选（与换壁纸同一套挑选规则：排除 disliked 和当前这张，优先没展示过的）
ipcMain.handle("get-next-image", () => {
  const row = pickFromLibrary(currentImageId);
  if (!row) return null;
  return { ...row, fileUrl: url.pathToFileURL(row.path).href };
});

// 空闲重置（渲染进程调用）
ipcMain.handle("reset-idle", resetIdleTimer);

// 获取预生成配置
ipcMain.handle("get-preload-config", () => preloadConfig);

// 设置预生成配置
ipcMain.handle("set-preload-config", (event, config) => {
  preloadConfig = { ...preloadConfig, ...config };
  saveDatabase();
  startPreloadCheck();
  return preloadConfig;
});

// 预生成运行状态（含退避信息，设置页展示“已暂停/下次尝试时间”）
ipcMain.handle("get-preload-status", () => ({
  enabled: preloadConfig.enabled,
  isGenerating: preloadConfig.isGenerating,
  failCount: preloadConfig.failCount,
  retryDelayMs: preloadConfig.retryDelayMs,
  pauseUntil: preloadConfig.pauseUntil,
  lastError: preloadConfig.lastError,
}));

// 手动恢复预生成（用户在设置页点“立即重试”）
ipcMain.handle("reset-preload-backoff", () => {
  resetPreloadBackoff();
  return { success: true };
});

// 立即换壁纸
ipcMain.handle("change-wallpaper", changeWallpaper);

// 重新启动自动换壁纸（当设置变更时调用）
ipcMain.handle("restart-auto-change", () => {
  startAutoChange();
  return { success: true };
});

// 定时换壁
let cronTask = null;
function startAutoChange() {
  if (cronTask) cronTask.stop();
  const enabled = getSetting("auto_change_enabled") !== "false";
  if (!enabled) return;
  
  const interval = parseInt(getSetting("interval")) || 60;
  console.log(`[定时换壁] 启动自动换壁纸，间隔 ${interval} 分钟`);
  cronTask = cron.schedule(`*/${interval} * * * *`, () => {
    console.log(`[定时换壁] 定时换壁纸触发`);
    changeWallpaper().catch(console.error);
  });
}

// 停止自动换壁纸
function stopAutoChange() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    console.log("[定时换壁] 已停止自动换壁纸");
  }
}

// ==================== 托盘 ====================
// 2026-10-30 修复：原来用内联 SVG 生成图标，而 nativeImage 不支持 SVG，
// 得到的是 0×0 空图；new Tray(空图) 又不报错，结果就是“托盘没图标、退不出去”。
// 现在优先加载打包进 asar 的 build/icon.ico，失败时回退到内置 PNG，两种情况都写日志。
const FALLBACK_TRAY_ICON_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAoElEQVRYhe2XQQ6AIAwErfFH+jo96+v0TXgxARG0bQhrE/ZYKJ1uCKHU5TTvLrum0TZRKnwPli7KgPEAtYpHEAQpHkD0kMKB4AAEs/8S3AE4wKBNdOv4iNFyiM+BO6ACSHX/Fi8OUFJigK8upS7YcoDbncQFWw5AAaSXi7vfhgOaB4abZ8MBKIDWfm5++xG1bzkc4CejWW2I5HAaq9J4fgJVyTRXgGwOKAAAAABJRU5ErkJggg==";

function loadTrayIcon() {
  const candidates = [
    path.join(__dirname, "build", "icon.ico"),
    path.join(__dirname, "build", "icon.png"),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) {
        console.warn("[托盘] 图标文件不存在:", file);
        continue;
      }
      let img = nativeImage.createFromPath(file);
      if (img.isEmpty()) {
        console.warn("[托盘] 图标加载结果为空:", file);
        continue;
      }
      const size = img.getSize();
      if (size.width > 32) {
        img = img.resize({ width: 32, height: 32, quality: "best" });
      }
      console.log(`[托盘] 图标已加载: ${file} (${size.width}x${size.height})`);
      return img;
    } catch (e) {
      console.error("[托盘] 图标加载异常:", file, e.message);
    }
  }
  console.warn("[托盘] 没有可用的图标文件，使用内置兜底图标");
  return nativeImage.createFromDataURL(FALLBACK_TRAY_ICON_PNG);
}

// 当前壁纸记录，用于决定托盘菜单项是否可点
function getRatingRow() {
  if (!dbReady || !currentImageId) return null;
  try {
    return dbQuery("SELECT id, status FROM images WHERE id = ?", [currentImageId]);
  } catch (e) {
    console.error("[托盘] 读取当前壁纸失败:", e.message);
    return null;
  }
}

// 托盘上的喜欢/不喜欢：复用与悬浮窗完全相同的 rateImage 逻辑
function trayRateImage(type) {
  const res = rateImage(currentImageId, type);
  console.log("[托盘] 评价:", type, res && res.message);
  notifyFloatHint(res && res.message, res && res.success ? "ok" : "err");
  return res;
}

async function trayNextWallpaper() {
  if (isChangingWallpaper) {
    notifyFloatHint("正在生成壁纸，请稍候", "err");
    return;
  }
  notifyFloatHint("正在切换壁纸…");
  try {
    const res = await changeWallpaper();
    if (!res || !res.success) {
      notifyFloatHint((res && res.error) || "切换失败，请重试", "err");
    }
  } catch (e) {
    console.error("[托盘] 下一个失败:", e.message);
    notifyFloatHint("切换失败：" + e.message, "err");
  }
}

// 每次右键时重新构建，保证置灰状态跟着当前壁纸走
function buildTrayMenu() {
  const row = getRatingRow();
  return Menu.buildFromTemplate([
    {
      label: "喜欢",
      enabled: !!row && row.status !== "liked",
      click: () => trayRateImage("liked"),
    },
    {
      label: "不喜欢",
      enabled: !!row && row.status !== "disliked",
      click: () => trayRateImage("disliked"),
    },
    { type: "separator" },
    {
      label: "下一个",
      enabled: !isChangingWallpaper,
      click: trayNextWallpaper,
    },
    { label: "设置", click: showSettingsWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

// 创建托盘图标。主窗口关闭后程序仍常驻，用户可通过托盘打开设置或退出。
function createTray() {
  if (tray) return;
  try {
    const icon = loadTrayIcon();
    tray = new Tray(icon);
    if (icon.isEmpty()) {
      console.error("[托盘] 图标为空，托盘图标将不可见");
    }
    tray.setToolTip("Driftwall · 随机壁纸");
    // 左键打开设置；右键弹出菜单，菜单项状态每次现算
    tray.on("click", showSettingsWindow);
    tray.on("right-click", () => tray.popUpContextMenu(buildTrayMenu()));
    console.log("[托盘] 创建完成");
  } catch (e) {
    console.error("[托盘] 创建失败:", e.message);
  }
}

// 打开日志目录（设置页底部的“打开日志目录”）
ipcMain.handle("open-log-dir", async () => {
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const err = await shell.openPath(logDir);
    if (err) throw new Error(err);
    return { success: true, path: logDir };
  } catch (e) {
    console.error("[日志] 打开日志目录失败:", e.message);
    return { success: false, error: e.message, path: logDir };
  }
});

ipcMain.handle("get-log-dir", () => logDir);

// 单实例：第二次双击 exe 时唤出已有实例的设置窗口，避免多个隐形托盘和重复定时任务
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log("[单实例] 已有实例在运行，本进程退出");
  app.quit();
} else {
  app.on("second-instance", () => {
    console.log("[单实例] 收到第二次启动请求，唤出设置窗口");
    if (app.isReady()) showSettingsWindow();
    else app.once("ready", showSettingsWindow);
  });

  app.whenReady().then(async () => {
    await initDatabase();
    loadPreloadConfig();
    // 不喜欢的图片存放目录
    const tempDir = path.join(dataRoot, "temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    createMainWindow();
    createFloatWindow();
    createTray();
    startPreloadCheck();
    // 识别启动时的桌面壁纸（放在悬浮窗创建之后，好把结果推给它）
    initCurrentImage();
    // 启动自动换壁纸
    startAutoChange();
    // 临时文件定期清理：启动 30 秒后清一次，之后每小时检查一次
    setTimeout(cleanTempFiles, 30 * 1000);
    setInterval(cleanTempFiles, 60 * 60 * 1000);
  });

  app.on("window-all-closed", () => {
    // 不退出，后台继续运行；用户可通过托盘图标打开设置或退出
    saveDatabase();
  });

  app.on("before-quit", () => {
    saveDatabase();
  });
}
