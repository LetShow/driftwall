const SETTINGS_KEYS = [
  'model_url', 'api_key', 'image_url', 'image_key',
  'auto_change_enabled', 'interval', 'llm_timeout', 'image_timeout', 'image_dir', 'temp_clean_interval',
  'change_mode', 'style_explore_rate',
  'float_display', 'float_position', 'float_hide_delay',
  'preload_enabled', 'preload_idle', 'preload_max',
  'theme_main_color', 'theme_bg_color', 'theme_card_bg',
  'theme_text_color', 'theme_text_secondary', 'theme_border_color',
  'theme_preset', 'theme_btn_like', 'theme_btn_dislike', 'theme_btn_settings',
  'theme_border_radius'
];

// 预设主题定义
const THEME_PRESETS = {
  default: {
    mainColor: '#007acc',
    bgColor: '#f5f5f5',
    cardBg: '#ffffff',
    textColor: '#333333',
    textSecondary: '#666666',
    borderColor: '#dddddd'
  },
  dark: {
    mainColor: '#3b82f6',
    bgColor: '#1e293b',
    cardBg: '#334155',
    textColor: '#f8fafc',
    textSecondary: '#94a3b8',
    borderColor: '#475569'
  },
  green: {
    mainColor: '#10b981',
    bgColor: '#f0fdf4',
    cardBg: '#ffffff',
    textColor: '#14532d',
    textSecondary: '#4ade80',
    borderColor: '#bbf7d0'
  },
  pink: {
    mainColor: '#ec4899',
    bgColor: '#fdf2f8',
    cardBg: '#ffffff',
    textColor: '#881337',
    textSecondary: '#f472b6',
    borderColor: '#fce7f3'
  }
};

// 将预设主题应用到 UI 输入框和 CSS 变量
function applyThemeToUI(theme) {
  if (!theme) return;

  // 应用到 CSS 变量（立即生效）
  document.documentElement.style.setProperty('--main-color', theme.mainColor || '#007acc');
  document.documentElement.style.setProperty('--main-color-hover', adjustColor(theme.mainColor || '#007acc', -20));
  document.documentElement.style.setProperty('--bg-color', theme.bgColor || '#f5f5f5');
  document.documentElement.style.setProperty('--card-bg', theme.cardBg || '#ffffff');
  document.documentElement.style.setProperty('--text-color', theme.textColor || '#333333');
  document.documentElement.style.setProperty('--text-secondary', theme.textSecondary || '#666666');
  document.documentElement.style.setProperty('--border-color', theme.borderColor || '#dddddd');

  // 应用到输入框
  const map = {
    'theme_main_color': theme.mainColor,
    'theme_bg_color': theme.bgColor,
    'theme_card_bg': theme.cardBg,
    'theme_text_color': theme.textColor,
    'theme_text_secondary': theme.textSecondary,
    'theme_border_color': theme.borderColor
  };
  for (const [id, val] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  }
}

// 简单的颜色加深/变浅（用于生成主色的 hover 色）
function adjustColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.min(255, (num >> 16) + percent));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0x00FF) + percent));
  const b = Math.max(0, Math.min(255, (num & 0x0000FF) + percent));
  return '#' + (r | (1 << 8)).toString(16).slice(1) + (g | (1 << 8)).toString(16).slice(1) + (b | (1 << 8)).toString(16).slice(1);
}

async function waitDbReady() {
  for (let i = 0; i < 50; i++) {
    const ready = await window.wallpaperApi.isDbReady();
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('数据库初始化超时');
}

async function loadSettings() {
  await waitDbReady();

  // 加载壁纸生成显示器设置
  const wallpaperDisplayEl = document.getElementById('wallpaper_display');
  if (wallpaperDisplayEl) {
    try {
      // 先加载保存的设置
      const savedSetting = await window.wallpaperApi.getSetting('wallpaper_display');
      wallpaperDisplayEl.value = savedSetting || 'primary';
      
      // 然后加载显示器列表
      const displays = await window.wallpaperApi.getDisplays();
      wallpaperDisplayEl.innerHTML = `
        <option value="primary">主显示器</option>
        <option value="current">当前壁纸所在显示器</option>
        ${displays.map(d => 
          `<option value="${d.index}">显示器 ${d.index + 1} (${d.label})</option>`
        ).join('')}
      `;
      
      // 恢复保存的设置
      wallpaperDisplayEl.value = savedSetting || 'primary';
    } catch (e) {
      console.log('加载壁纸生成显示器设置失败:', e.message);
    }
  }

  // 加载多显示器列表并填充浮动按钮显示器选择
  const floatDisplayEl = document.getElementById('float_display');
  if (floatDisplayEl) {
    try {
      const displays = await window.wallpaperApi.getDisplays();
      floatDisplayEl.innerHTML = displays.map(d =>
        `<option value="${d.index}">显示器 ${d.index + 1} (${d.label})</option>`
      ).join('');
    } catch (e) {
      console.log('加载显示器列表失败:', e.message);
    }
  }

  // 先加载预设主题
  const preset = await window.wallpaperApi.getSetting('theme_preset');
  const presetEl = document.getElementById('theme_preset');
  if (presetEl) {
    presetEl.value = preset || 'default';
    const presetData = THEME_PRESETS[presetEl.value];
    if (presetData) {
      applyThemeToUI(presetData);
    }
  }

  // 加载所有设置项（包括颜色）
  for (const key of SETTINGS_KEYS) {
    const el = document.getElementById(key);
    if (el) {
      const val = await window.wallpaperApi.getSetting(key);
      if (el.type === 'checkbox') {
        el.checked = val !== 'false' && val !== '';
      } else {
        // 没保存过时用 data-default（select 没有 defaultValue）
        el.value = val || (el.dataset && el.dataset.default) || (el.defaultValue || '');
      }
    }
  }

  // 如果保存了自定义颜色，优先应用保存的值（覆盖预设）
  const savedMain = await window.wallpaperApi.getSetting('theme_main_color');
  if (savedMain) {
    document.documentElement.style.setProperty('--main-color', savedMain);
    document.documentElement.style.setProperty('--main-color-hover', adjustColor(savedMain, -20));
  }
  const savedBg = await window.wallpaperApi.getSetting('theme_bg_color');
  if (savedBg) document.documentElement.style.setProperty('--bg-color', savedBg);
  const savedCard = await window.wallpaperApi.getSetting('theme_card_bg');
  if (savedCard) document.documentElement.style.setProperty('--card-bg', savedCard);
  const savedText = await window.wallpaperApi.getSetting('theme_text_color');
  if (savedText) document.documentElement.style.setProperty('--text-color', savedText);
  const savedTextSec = await window.wallpaperApi.getSetting('theme_text_secondary');
  if (savedTextSec) document.documentElement.style.setProperty('--text-secondary', savedTextSec);
  const savedBorder = await window.wallpaperApi.getSetting('theme_border_color');
  if (savedBorder) document.documentElement.style.setProperty('--border-color', savedBorder);

  // 同步应用到悬浮按钮
  try {
    const theme = await window.wallpaperApi.getTheme();
    if (theme) {
      document.documentElement.style.setProperty('--btn-like', theme.btnLike || '#4caf50');
      document.documentElement.style.setProperty('--btn-dislike', theme.btnDislike || '#f44336');
      document.documentElement.style.setProperty('--btn-settings', theme.btnSettings || '#2196f3');
      document.documentElement.style.setProperty('--main-radius', theme.borderRadius || '24px');
    }
  } catch (e) {
    console.log('加载悬浮按钮主题失败:', e.message);
  }
}

async function saveSettings() {
  const btn = document.querySelector('button.primary');
  const msg = document.getElementById('msg');
  btn.disabled = true;
  btn.textContent = '保存中...';

  try {
    for (const key of SETTINGS_KEYS) {
      const el = document.getElementById(key);
      if (el) {
        const val = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value.trim();
        await window.wallpaperApi.setSetting(key, val);
      }
    }

    // 应用预生成配置
    await window.wallpaperApi.setPreloadConfig({
      enabled: document.getElementById('preload_enabled').checked,
      maxCount: parseInt(document.getElementById('preload_max').value) || 10,
      idleMinutes: parseInt(document.getElementById('preload_idle').value) || 5
    });

    // 保存主题色
    const theme = {
      mainColor: document.getElementById('theme_main_color').value,
      bgColor: document.getElementById('theme_bg_color').value,
      cardBg: document.getElementById('theme_card_bg').value,
      textColor: document.getElementById('theme_text_color').value,
      textSecondary: document.getElementById('theme_text_secondary').value,
      borderColor: document.getElementById('theme_border_color').value,
      preset: document.getElementById('theme_preset').value,
      btnLike: document.getElementById('theme_btn_like')?.value || '#4caf50',
      btnDislike: document.getElementById('theme_btn_dislike')?.value || '#f44336',
      btnSettings: document.getElementById('theme_btn_settings')?.value || '#2196f3',
      borderRadius: document.getElementById('theme_border_radius')?.value || '16px',
      // 位置由悬浮窗自己按贴边方向维护，这里没有对应控件时不覆盖
      position: document.getElementById('float_position')?.value,
      hideDelay: parseInt(document.getElementById('float_hide_delay')?.value || '1500')
    };
    await window.wallpaperApi.setTheme(theme);

    // 保存壁纸生成显示器设置
    const wallpaperDisplay = document.getElementById('wallpaper_display').value;
    await window.wallpaperApi.setWallpaperDisplay(wallpaperDisplay);

    // 如果修改了自动换壁纸相关设置，重新启动定时任务
    const autoChangeEnabled = document.getElementById('auto_change_enabled').checked;
    const interval = document.getElementById('interval').value;
    const oldAutoChange = await window.wallpaperApi.getSetting('auto_change_enabled');
    const oldInterval = await window.wallpaperApi.getSetting('interval');
    
    if (autoChangeEnabled !== (oldAutoChange !== 'false') || interval !== oldInterval) {
      await window.wallpaperApi.restartAutoChange();
    }

    msg.className = 'msg success';
    msg.textContent = '设置已保存';
    msg.style.display = 'block';
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = '保存失败：' + err.message;
    msg.style.display = 'block';
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '保存设置';
      msg.style.display = 'none';
    }, 2000);
  }
}

async function changeNow() {
  const btn = document.querySelector('button.secondary');
  const msg = document.getElementById('msg');
  const progressGroup = document.getElementById('progressGroup');
  const progressLog = document.getElementById('progressLog');

  btn.disabled = true;
  btn.textContent = '生成中...';
  progressGroup.style.display = 'block';
  progressLog.textContent = '正在开始...';
  msg.style.display = 'none';

  // 监听主进程进度通知
  const unsubscribe = window.wallpaperApi.onProgress((message) => {
    progressLog.textContent += '\n' + message;
    progressLog.scrollTop = progressLog.scrollHeight;
  });

  try {
    const result = await window.wallpaperApi.changeWallpaper();
    if (result && result.success) {
      msg.className = 'msg success';
      msg.textContent = result.fromLibrary
        ? '壁纸已更换成功（来自预生成库，秒出）'
        : `壁纸已更换成功！耗时 ${Math.round(result.elapsed / 1000)} 秒`;
      progressGroup.style.display = 'none';
      loadPreview();
    } else {
      msg.className = 'msg error';
      msg.textContent = '换壁纸失败：' + (result ? result.error : '未知错误');
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = '换壁纸失败：' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '立即换壁纸';
    msg.style.display = 'block';
    setTimeout(() => { progressGroup.style.display = 'none'; }, 5000);
  }
}

// 用户活动监听：重置空闲计时器
// 只在用户与程序有明确交互时重置（点击、键盘输入），不监听被动的鼠标移动和滚动
function setupIdleReset() {
  const events = ['keydown', 'click', 'mousedown'];
  let lastReset = 0;
  function onActivity() {
    const now = Date.now();
    if (now - lastReset > 1000) { // 每秒最多重置一次
      window.wallpaperApi.resetIdle().catch(() => {});
      lastReset = now;
    }
  }
  events.forEach(ev => window.addEventListener(ev, onActivity, { passive: true }));
}

// 主题色实时应用：颜色选择器变化时立即更新 CSS 变量
function setupThemeListeners() {
  const presetEl = document.getElementById('theme_preset');
  if (presetEl) {
    presetEl.addEventListener('change', (e) => {
      const presetName = e.target.value;
      const presetData = THEME_PRESETS[presetName];
      if (presetData) {
        applyThemeToUI(presetData);
      }
    });
  }

  // 各颜色输入框变化时实时应用
  const colorIds = [
    'theme_main_color', 'theme_bg_color', 'theme_card_bg',
    'theme_text_color', 'theme_text_secondary', 'theme_border_color'
  ];
  colorIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        document.documentElement.style.setProperty('--main-color', document.getElementById('theme_main_color').value);
        document.documentElement.style.setProperty('--main-color-hover', adjustColor(document.getElementById('theme_main_color').value, -20));
        document.documentElement.style.setProperty('--bg-color', document.getElementById('theme_bg_color').value);
        document.documentElement.style.setProperty('--card-bg', document.getElementById('theme_card_bg').value);
        document.documentElement.style.setProperty('--text-color', document.getElementById('theme_text_color').value);
        document.documentElement.style.setProperty('--text-secondary', document.getElementById('theme_text_secondary').value);
        document.documentElement.style.setProperty('--border-color', document.getElementById('theme_border_color').value);
        // 切换到自定义模式
        if (presetEl) presetEl.value = 'custom';
      });
    }
  });
}

// 当前壁纸预览（设置页“当前壁纸预览”卡片）
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function loadPreview() {
  const imgEl = document.getElementById('previewImg');
  const emptyEl = document.getElementById('previewEmpty');
  const kwEl = document.getElementById('previewKeywords');
  if (!imgEl || !emptyEl || !kwEl) return;
  try {
    await waitDbReady(); // 数据库没就绪时先等一下，避免误显示“暂无壁纸”
    const img = await window.wallpaperApi.getCurrentImage();
    if (!img || !img.fileUrl) {
      imgEl.style.display = 'none';
      imgEl.removeAttribute('src');
      emptyEl.style.display = 'block';
      emptyEl.textContent = '暂无壁纸，点击"立即换壁纸"生成';
      kwEl.innerHTML = '';
      return;
    }
    if (imgEl.getAttribute('src') !== img.fileUrl) imgEl.src = img.fileUrl;
    imgEl.style.display = 'block';
    emptyEl.style.display = 'none';

    const statusMap = { liked: '❤️ 喜欢', disliked: '👎 不喜欢', normal: '正常' };
    let kws = [];
    try { kws = JSON.parse(img.keywords || '[]'); } catch (e) {}
    kwEl.innerHTML =
      `<span>状态：${statusMap[img.status] || escapeHtml(img.status)}</span>` +
      `<span>权重：${img.weight != null ? img.weight : '-'}</span>` +
      kws.map((k) => `<span>${escapeHtml(k)}</span>`).join('');
  } catch (e) {
    console.log('加载预览失败:', e.message);
  }
}

loadSettings();
setupIdleReset();
setupThemeListeners();
loadPreview();
setInterval(loadPreview, 10000);
// 换壁纸后主进程会推送当前壁纸，立即刷新预览
window.wallpaperApi.onCurrentImage(() => loadPreview());
