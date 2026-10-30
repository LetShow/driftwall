const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallpaperApi', {
  isDbReady: () => ipcRenderer.invoke('is-db-ready'),
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
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
    ipcRenderer.on('progress', (event, message) => callback(message));
  },
  // 监听主题变更通知
  onThemeChanged: (callback) => {
    ipcRenderer.on('theme-changed', (event, theme) => callback(theme));
  },
  // 打开主设置窗口
  openMainWindow: () => ipcRenderer.send('open-settings'),
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
