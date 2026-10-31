const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallpaperApi', {
  isDbReady: () => ipcRenderer.invoke('is-db-ready'),
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  // 接口 Profile（模型接入页）
  getProfileMeta: () => ipcRenderer.invoke('get-profile-meta'),
  getProfileDefaults: (role, template) => ipcRenderer.invoke('get-profile-defaults', role, template),
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  saveProfile: (role, profile) => ipcRenderer.invoke('save-profile', role, profile),
  testConnection: (role, profile) => ipcRenderer.invoke('test-connection', role, profile),
  // 预生成运行状态（退避/暂停信息）
  getPreloadStatus: () => ipcRenderer.invoke('get-preload-status'),
  resetPreloadBackoff: () => ipcRenderer.invoke('reset-preload-backoff'),
  onPreloadStatus: (callback) => {
    ipcRenderer.on('preload-status', (event, payload) => callback(payload));
  },
  // 正式生成失败时主进程推送的错误（设置页顶部横幅）
  onApiError: (callback) => {
    ipcRenderer.on('api-error', (event, payload) => callback(payload));
  },
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  getPreloadConfig: () => ipcRenderer.invoke('get-preload-config'),
  setPreloadConfig: (config) => ipcRenderer.invoke('set-preload-config', config),
  getNextImage: () => ipcRenderer.invoke('get-next-image'),
  getCurrentImage: () => ipcRenderer.invoke('get-current-image'),
  likeImage: (id) => ipcRenderer.invoke('like-image', id),
  dislikeImage: (id) => ipcRenderer.invoke('dislike-image', id),
  ignoreImage: (id) => ipcRenderer.invoke('ignore-image', id),
  changeWallpaper: () => ipcRenderer.invoke('change-wallpaper'),
  restartAutoChange: () => ipcRenderer.invoke('restart-auto-change'),
  resetIdle: () => ipcRenderer.invoke('reset-idle'),
  // 监听主进程进度通知
  onProgress: (callback) => {
    const listener = (event, message) => callback(message);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
  // 监听主题变更通知
  onThemeChanged: (callback) => {
    ipcRenderer.on('theme-changed', (event, theme) => callback(theme));
  },
  // 打开主设置窗口
  openMainWindow: () => ipcRenderer.send('open-settings'),
  // 打开日志目录 / 获取日志路径
  openLogDir: () => ipcRenderer.invoke('open-log-dir'),
  getLogDir: () => ipcRenderer.invoke('get-log-dir'),
  // 接收主进程发来的悬浮窗提示（托盘操作后反馈）
  onFloatHint: (callback) => {
    ipcRenderer.on('float-hint', (event, payload) => callback(payload));
  },
  // 获取所有显示器列表（多显示器选择）
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  // 获取壁纸生成显示器设置
  getWallpaperDisplay: () => ipcRenderer.invoke('get-wallpaper-display'),
  // 设置壁纸生成显示器
  setWallpaperDisplay: (value) => ipcRenderer.invoke('set-wallpaper-display', value),
  // 移动悬浮窗（拖动用）；persist=true 时同时持久化坐标
  moveFloat: (x, y, persist = false) => ipcRenderer.send('move-float', x, y, persist),
  // 接收悬浮窗初始位置
  onFloatPos: (callback) => {
    ipcRenderer.on('float-pos', (event, pos) => callback(pos));
  },
  // 接收"当前壁纸"变更（换壁纸后主进程主动推送）
  onCurrentImage: (callback) => {
    ipcRenderer.on('current-image', (event, image) => callback(image));
  },
});
