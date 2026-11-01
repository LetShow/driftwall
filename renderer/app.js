const SETTINGS_KEYS = [
  'auto_change_enabled', 'interval', 'llm_timeout', 'image_timeout', 'image_dir', 'temp_clean_interval',
  'change_mode', 'style_explore_rate',
  'float_display', 'float_hide_delay',
  'preload_enabled', 'preload_idle', 'preload_max',
  'theme_main_color', 'theme_bg_color', 'theme_card_bg',
  'theme_text_color', 'theme_text_secondary', 'theme_border_color',
  'theme_preset', 'theme_btn_like', 'theme_btn_dislike', 'theme_btn_settings',
  'theme_border_radius'
];

// 接口 Profile 的字段（ADR-011）
const PROFILE_ROLES = ['llm', 'image'];
const ROLE_LABELS = { llm: 'LLM', image: '文生图' };

// 调用频率限制默认值（与主进程 getRateLimitConfig 保持一致）
const RATE_LIMIT_DEFAULTS = {
  llm: { enabled: true, windowMinutes: 60, maxCalls: 30, penaltyMinutes: 30 },
  image: { enabled: true, windowMinutes: 60, maxCalls: 20, penaltyMinutes: 60 }
};

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

// ---------- 小工具 ----------

function el(id) {
  return document.getElementById(id);
}

function fieldValue(id) {
  const node = el(id);
  return node ? node.value : '';
}

function fieldNumber(id, fallback) {
  const n = Number(fieldValue(id));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fieldChecked(id) {
  const node = el(id);
  return !!(node && node.checked);
}

function setFieldValue(id, value) {
  const node = el(id);
  if (node) node.value = value === undefined || value === null ? '' : String(value);
}

function setFieldChecked(id, value) {
  const node = el(id);
  if (node) node.checked = !!value;
}

function showMessage(text, kind) {
  const msg = el('msg');
  if (!msg) return;
  msg.className = 'msg ' + (kind || 'success');
  msg.textContent = text;
  msg.style.display = 'block';
  clearTimeout(showMessage._timer);
  showMessage._timer = setTimeout(() => {
    msg.style.display = 'none';
  }, 3200);
}

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
    const node = el(id);
    if (node && val) node.value = val;
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

// ---------- 页面切换 ----------

function setupPageNav() {
  const nav = el('nav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-page]');
    if (!btn) return;
    const page = btn.dataset.page;
    nav.querySelectorAll('button[data-page]').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    document.querySelectorAll('section.page').forEach((section) => {
      section.classList.toggle('active', section.dataset.page === page);
    });
    const content = document.querySelector('.content');
    if (content) content.scrollTop = 0;
    if (page === 'preload') refreshPreloadStatus();
    if (page === 'ratelimit') PROFILE_ROLES.forEach((role) => refreshRateLimitStatus(role));
  });
}

// ---------- Profile 读写 ----------

function parseJsonField(id, label) {
  const raw = fieldValue(id).trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label}不是合法 JSON：${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label}必须是一个 JSON 对象`);
  }
  return parsed;
}

function splitSizeTiers(text) {
  return String(text || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readProfile(role) {
  const label = ROLE_LABELS[role];
  return {
    template: fieldValue(`${role}_template`),
    url: fieldValue(`${role}_url`).trim(),
    key: fieldValue(`${role}_key`),
    model: fieldValue(`${role}_model`).trim(),
    auth: fieldValue(`${role}_auth`) || 'bearer',
    authParam: fieldValue(`${role}_authParam`).trim() || 'key',
    headers: parseJsonField(`${role}_headers`, `${label}自定义请求头`),
    body: parseJsonField(`${role}_body`, `${label}请求体`),
    responsePath: fieldValue(`${role}_responsePath`).trim(),
    sizeMode: fieldValue(`${role}_sizeMode`) || 'auto',
    customSize: fieldValue(`${role}_customSize`).trim(),
    sizeTiers: splitSizeTiers(fieldValue(`${role}_sizeTiers`)),
    downloadWithAuth: fieldChecked(`${role}_downloadWithAuth`),
    timeoutSec: fieldNumber(`${role}_timeoutSec`, 0),
    poll: {
      enabled: fieldChecked(`${role}_poll_enabled`),
      url: fieldValue(`${role}_poll_url`).trim(),
      method: fieldValue(`${role}_poll_method`) || 'GET',
      taskIdPath: fieldValue(`${role}_poll_taskIdPath`).trim(),
      statusPath: fieldValue(`${role}_poll_statusPath`).trim(),
      successValues: fieldValue(`${role}_poll_successValues`).trim(),
      failValues: fieldValue(`${role}_poll_failValues`).trim(),
      resultPath: fieldValue(`${role}_poll_resultPath`).trim(),
      intervalSec: fieldNumber(`${role}_poll_intervalSec`, 5),
      timeoutSec: fieldNumber(`${role}_poll_timeoutSec`, 300)
    }
  };
}

function fillProfile(role, profile) {
  if (!profile) return;
  setFieldValue(`${role}_template`, profile.template);
  setFieldValue(`${role}_url`, profile.url);
  setFieldValue(`${role}_key`, profile.key);
  setFieldValue(`${role}_model`, profile.model);
  setFieldValue(`${role}_auth`, profile.auth);
  setFieldValue(`${role}_authParam`, profile.authParam || 'key');
  setFieldValue(`${role}_headers`, JSON.stringify(profile.headers || {}, null, 2));
  setFieldValue(`${role}_body`, JSON.stringify(profile.body || {}, null, 2));
  setFieldValue(`${role}_responsePath`, profile.responsePath);
  setFieldValue(`${role}_sizeMode`, profile.sizeMode || 'auto');
  setFieldValue(`${role}_customSize`, profile.customSize || '');
  if (Array.isArray(profile.sizeTiers)) {
    setFieldValue(`${role}_sizeTiers`, profile.sizeTiers.join(','));
  }
  setFieldChecked(`${role}_downloadWithAuth`, profile.downloadWithAuth);
  setFieldValue(`${role}_timeoutSec`, profile.timeoutSec || 0);

  const poll = profile.poll || {};
  setFieldChecked(`${role}_poll_enabled`, poll.enabled);
  setFieldValue(`${role}_poll_url`, poll.url || '');
  setFieldValue(`${role}_poll_method`, (poll.method || 'GET').toUpperCase());
  setFieldValue(`${role}_poll_taskIdPath`, poll.taskIdPath || '');
  setFieldValue(`${role}_poll_statusPath`, poll.statusPath || '');
  setFieldValue(`${role}_poll_successValues`, poll.successValues || 'succeeded,success,completed');
  setFieldValue(`${role}_poll_failValues`, poll.failValues || 'failed,error,cancelled');
  setFieldValue(`${role}_poll_resultPath`, poll.resultPath || '');
  setFieldValue(`${role}_poll_intervalSec`, poll.intervalSec || 5);
  setFieldValue(`${role}_poll_timeoutSec`, poll.timeoutSec || 300);

  // 尺寸/轮询相关的字段只有文生图有，设置不存在的元素会被忽略
}

async function loadProfileMeta() {
  const meta = await window.wallpaperApi.getProfileMeta();
  if (!meta) return;
  for (const role of PROFILE_ROLES) {
    const select = el(`${role}_template`);
    if (!select) continue;
    const templates = (meta.templates && meta.templates[role]) || [];
    select.innerHTML = templates
      .map((t) => `<option value="${t.id}">${t.label}</option>`)
      .join('');
  }
}

// 切换模板时只覆盖模板负责的字段，地址/Key/模型名保持用户输入
async function applyTemplateDefaults(role) {
  const template = fieldValue(`${role}_template`);
  if (!template) return;
  try {
    const defaults = await window.wallpaperApi.getProfileDefaults(role, template);
    if (!defaults) return;
    setFieldValue(`${role}_auth`, defaults.auth || 'bearer');
    setFieldValue(`${role}_body`, JSON.stringify(defaults.body || {}, null, 2));
    setFieldValue(`${role}_responsePath`, defaults.responsePath || '');
    if (Array.isArray(defaults.sizeTiers) && defaults.sizeTiers.length > 0) {
      setFieldValue(`${role}_sizeTiers`, defaults.sizeTiers.join(','));
    }
  } catch (err) {
    console.log('加载模板默认值失败:', err.message);
  }
}

function setupProfileEvents() {
  for (const role of PROFILE_ROLES) {
    const select = el(`${role}_template`);
    if (select) {
      select.addEventListener('change', () => applyTemplateDefaults(role));
    }
    const testBtn = el(`${role}_test`);
    if (testBtn) {
      testBtn.addEventListener('click', () => testConnection(role));
    }
  }
}

// ---------- 调用频率限制 ----------

function fillRateLimitConfig(role, config) {
  const def = RATE_LIMIT_DEFAULTS[role];
  const cfg = config || def;
  setFieldChecked(`${role}_rl_enabled`, cfg.enabled !== false);
  setFieldValue(`${role}_rl_window`, cfg.windowMinutes || def.windowMinutes);
  setFieldValue(`${role}_rl_max`, cfg.maxCalls || def.maxCalls);
  setFieldValue(`${role}_rl_penalty`, cfg.penaltyMinutes || def.penaltyMinutes);
}

function readRateLimitConfig(role) {
  const def = RATE_LIMIT_DEFAULTS[role];
  return {
    enabled: fieldChecked(`${role}_rl_enabled`),
    windowMinutes: fieldNumber(`${role}_rl_window`, def.windowMinutes),
    maxCalls: fieldNumber(`${role}_rl_max`, def.maxCalls),
    penaltyMinutes: fieldNumber(`${role}_rl_penalty`, def.penaltyMinutes)
  };
}

async function loadRateLimitConfigs() {
  for (const role of PROFILE_ROLES) {
    try {
      const config = await window.wallpaperApi.getRateLimitConfig(role);
      fillRateLimitConfig(role, config);
    } catch (err) {
      console.log(`加载${ROLE_LABELS[role]}频率限制配置失败:`, err.message);
    }
    refreshRateLimitStatus(role);
  }
}

async function refreshRateLimitStatus(role) {
  const box = el(`${role}_rl_status`);
  if (!box) return;
  const label = ROLE_LABELS[role] || role;
  try {
    const [check, stats] = await Promise.all([
      window.wallpaperApi.checkRateLimit(role),
      window.wallpaperApi.getApiUsageStats(role)
    ]);
    if (!check) {
      box.className = 'status-box';
      box.textContent = '未获取到调用状态';
      return;
    }

    const lines = [];
    if (!check.enabled) {
      box.className = 'status-box';
      lines.push(`${label} 频率限制已关闭，请留意服务方的额度限制`);
    } else if (!check.allowed) {
      box.className = 'status-box warn';
      lines.push(check.reason || '已超出频率限制');
      if (check.penaltyUntil) {
        lines.push(`解禁时间：${new Date(check.penaltyUntil).toLocaleString()}`);
      }
    } else {
      box.className = 'status-box';
      lines.push(
        `运行正常：最近 ${check.windowMinutes} 分钟内已调用 ${check.used}/${check.maxCalls} 次，` +
        `还可调用 ${check.remaining} 次`
      );
    }
    if (stats && typeof stats.total === 'number') {
      lines.push(`近 24 小时：成功 ${stats.success} 次，失败 ${stats.errors} 次`);
    }
    box.textContent = lines.join('\n');
  } catch (err) {
    box.className = 'status-box';
    box.textContent = '读取调用状态失败：' + err.message;
  }
}

function setupRateLimitEvents() {
  document.querySelectorAll('[data-rl-refresh]').forEach((btn) => {
    btn.addEventListener('click', () => refreshRateLimitStatus(btn.dataset.rlRefresh));
  });
  document.querySelectorAll('[data-rl-reset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const role = btn.dataset.rlReset;
      const label = ROLE_LABELS[role] || role;
      if (!confirm(`确定清空 ${label} 的调用统计吗？这会同时解除当前的超限暂停。`)) return;
      try {
        const res = await window.wallpaperApi.resetApiUsage(role);
        if (!res || !res.success) throw new Error((res && res.error) || '未知错误');
        showMessage(`${label} 调用统计已清空`, 'success');
        refreshRateLimitStatus(role);
      } catch (err) {
        showMessage('清空统计失败：' + err.message, 'error');
      }
    });
  });
}

async function testConnection(role) {
  const btn = el(`${role}_test`);
  const out = el(`${role}_test_result`);
  if (!btn || !out) return;

  let profile;
  try {
    profile = readProfile(role);
  } catch (err) {
    out.className = 'test-result fail';
    out.textContent = err.message;
    return;
  }

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中...';
  out.className = 'test-result';
  out.textContent = '正在请求接口，请稍候...';

  try {
    const res = await window.wallpaperApi.testConnection(role, profile);
    if (res && res.success) {
      const lines = [`连接成功，耗时 ${res.elapsedMs} ms`];
      if (res.detail) lines.push(`返回摘要：${res.detail}`);
      out.className = 'test-result ok';
      out.textContent = lines.join('\n');
    } else {
      const lines = [`连接失败，耗时 ${res ? res.elapsedMs : 0} ms`];
      if (res && res.status) lines.push(`HTTP 状态：${res.status}`);
      if (res && res.errorCode) lines.push(`错误码：${res.errorCode}`);
      lines.push(`详情：${(res && res.detail) || '未知错误'}`);
      out.className = 'test-result fail';
      out.textContent = lines.join('\n');
    }
  } catch (err) {
    out.className = 'test-result fail';
    out.textContent = '测试失败：' + (err && err.message ? err.message : err);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------- 加载 / 保存 ----------

async function loadSettings() {
  await waitDbReady();

  // 模型接入：先填充模板下拉，再填两份 profile
  try {
    await loadProfileMeta();
    const profiles = await window.wallpaperApi.getProfiles();
    if (profiles) {
      fillProfile('llm', profiles.llm);
      fillProfile('image', profiles.image);
    }
  } catch (err) {
    console.log('加载接口配置失败:', err.message);
  }
  setupProfileEvents();

  // 加载壁纸生成显示器设置
  const wallpaperDisplayEl = el('wallpaper_display');
  if (wallpaperDisplayEl) {
    try {
      const savedSetting = await window.wallpaperApi.getSetting('wallpaper_display');
      wallpaperDisplayEl.value = savedSetting || 'all';

      const displays = await window.wallpaperApi.getDisplays();
      wallpaperDisplayEl.innerHTML = `
        <option value="all">所有显示器（同一张壁纸，默认）</option>
        <option value="rotate">轮流更换（每次换到下一台显示器）</option>
        <option value="primary">仅主显示器</option>
        <option value="current">当前壁纸所在显示器</option>
        ${displays.map(d =>
          `<option value="${d.index}">显示器 ${d.index + 1} (${d.label})</option>`
        ).join('')}
      `;
      wallpaperDisplayEl.value = savedSetting || 'all';
      wallpaperDisplayEl.addEventListener('change', () => refreshRotationStatus());
      setupRotationEvents();
      refreshRotationStatus();
    } catch (e) {
      console.log('加载壁纸生成显示器设置失败:', e.message);
    }
  }

  // 加载多显示器列表并填充浮动按钮显示器选择
  const floatDisplayEl = el('float_display');
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
  const presetEl = el('theme_preset');
  if (presetEl) {
    presetEl.value = preset || 'default';
    const presetData = THEME_PRESETS[presetEl.value];
    if (presetData) {
      applyThemeToUI(presetData);
    }
  }

  // 加载所有设置项（包括颜色）
  for (const key of SETTINGS_KEYS) {
    const node = el(key);
    if (node) {
      const val = await window.wallpaperApi.getSetting(key);
      if (node.type === 'checkbox') {
        node.checked = val !== 'false' && val !== '';
      } else if (key === 'float_display') {
        // 历史数据里可能是空字符串，空表示主显示器（索引 0）
        node.value = val || '0';
      } else {
        node.value = val || (node.dataset && node.dataset.default) || (node.defaultValue || '');
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

  // 调用频率限制配置
  await loadRateLimitConfigs();

  refreshPreloadStatus();
}

async function saveSettings() {
  const btn = el('saveSettingsBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '保存中...';
  }

  try {
    // 先校验两份 profile 的 JSON，避免保存到一半才报错
    let profiles;
    try {
      profiles = {
        llm: readProfile('llm'),
        image: readProfile('image')
      };
    } catch (err) {
      showMessage('保存失败：' + err.message, 'error');
      return;
    }

    for (const role of PROFILE_ROLES) {
      const res = await window.wallpaperApi.saveProfile(role, profiles[role]);
      if (!res || !res.success) {
        throw new Error((res && res.error) || `${ROLE_LABELS[role]} 配置保存失败`);
      }
    }

    // 保存调用频率限制配置
    for (const role of PROFILE_ROLES) {
      const res = await window.wallpaperApi.setRateLimitConfig(role, readRateLimitConfig(role));
      if (!res || !res.success) {
        throw new Error((res && res.error) || `${ROLE_LABELS[role]} 频率限制保存失败`);
      }
    }

    for (const key of SETTINGS_KEYS) {
      const node = el(key);
      if (node) {
        const val = node.type === 'checkbox' ? (node.checked ? 'true' : 'false') : node.value.trim();
        await window.wallpaperApi.setSetting(key, val);
      }
    }

    // 应用预生成配置
    await window.wallpaperApi.setPreloadConfig({
      enabled: fieldChecked('preload_enabled'),
      maxCount: parseInt(fieldValue('preload_max')) || 10,
      idleMinutes: parseInt(fieldValue('preload_idle')) || 5
    });

    // 保存主题色
    const theme = {
      mainColor: fieldValue('theme_main_color'),
      bgColor: fieldValue('theme_bg_color'),
      cardBg: fieldValue('theme_card_bg'),
      textColor: fieldValue('theme_text_color'),
      textSecondary: fieldValue('theme_text_secondary'),
      borderColor: fieldValue('theme_border_color'),
      preset: fieldValue('theme_preset'),
      btnLike: fieldValue('theme_btn_like') || '#4caf50',
      btnDislike: fieldValue('theme_btn_dislike') || '#f44336',
      btnSettings: fieldValue('theme_btn_settings') || '#2196f3',
      borderRadius: fieldValue('theme_border_radius') || '16px',
      // 位置由悬浮窗自己按贴边方向维护，这里没有对应控件时不能覆盖
      position: el('float_position') ? fieldValue('float_position') : undefined,
      hideDelay: parseInt(fieldValue('float_hide_delay') || '1500')
    };
    await window.wallpaperApi.setTheme(theme);

    // 保存壁纸生成显示器设置
    await window.wallpaperApi.setWallpaperDisplay(fieldValue('wallpaper_display'));

    // 如果修改了自动换壁纸相关设置，重新启动定时任务
    const autoChangeEnabled = fieldChecked('auto_change_enabled');
    const interval = fieldValue('interval');
    const oldAutoChange = await window.wallpaperApi.getSetting('auto_change_enabled');
    const oldInterval = await window.wallpaperApi.getSetting('interval');

    if (autoChangeEnabled !== (oldAutoChange !== 'false') || interval !== oldInterval) {
      await window.wallpaperApi.restartAutoChange();
    }

    showMessage('设置已保存', 'success');
    PROFILE_ROLES.forEach((role) => refreshRateLimitStatus(role));
    refreshRotationStatus();
    refreshPreloadStatus();
  } catch (err) {
    showMessage('保存失败：' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '保存设置';
    }
  }
}

async function changeNow() {
  const btn = el('changeNowBtn');
  const msg = el('msg');
  const progressGroup = el('progressGroup');
  const progressLog = el('progressLog');

  if (btn) {
    btn.disabled = true;
    btn.textContent = '生成中...';
  }
  if (progressGroup) progressGroup.style.display = 'block';
  if (progressLog) progressLog.textContent = '正在开始...';
  if (msg) msg.style.display = 'none';

  // 监听主进程进度通知
  const unsubscribe = window.wallpaperApi.onProgress((message) => {
    if (!progressLog) return;
    progressLog.textContent += '\n' + message;
    progressLog.scrollTop = progressLog.scrollHeight;
  });

  try {
    const result = await window.wallpaperApi.changeWallpaper();
    if (result && result.success) {
      let text = result.fromLibrary
        ? '壁纸已更换成功（来自预生成库，秒出）'
        : `壁纸已更换成功！耗时 ${Math.round(result.elapsed / 1000)} 秒`;
      if (result.rotation) {
        text += `｜本次换到显示器 ${result.rotation.displayIndex + 1}`;
      }
      showMessage(text, 'success');
      if (progressGroup) progressGroup.style.display = 'none';
      loadPreview();
      refreshRotationStatus();
    } else {
      showMessage('换壁纸失败：' + (result ? result.error : '未知错误'), 'error');
    }
  } catch (err) {
    showMessage('换壁纸失败：' + err.message, 'error');
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe();
    if (btn) {
      btn.disabled = false;
      btn.textContent = '立即换壁纸';
    }
    setTimeout(() => { if (progressGroup) progressGroup.style.display = 'none'; }, 5000);
  }
}

// ---------- 预生成状态 ----------

function formatRemain(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

function renderPreloadStatus(status) {
  const box = el('preloadStatus');
  if (!box) return;
  if (!status) {
    box.className = 'status-box';
    box.textContent = '未获取到预生成状态';
    return;
  }
  if (status.isGenerating) {
    box.className = 'status-box';
    box.textContent = '正在后台生成图片...';
    return;
  }
  if (status.pauseUntil && status.pauseUntil > Date.now()) {
    box.className = 'status-box warn';
    box.textContent =
      `已暂停：${status.lastError || '最近一次生成失败'}\n` +
      `下次尝试：约 ${formatRemain(status.pauseUntil - Date.now())}后（连续失败 ${status.failCount} 次）`;
    return;
  }
  box.className = 'status-box';
  box.textContent = status.enabled
    ? `运行正常${status.failCount ? `（连续失败 ${status.failCount} 次）` : ''}`
    : '预生成已关闭';
}

async function refreshPreloadStatus() {
  try {
    const status = await window.wallpaperApi.getPreloadStatus();
    renderPreloadStatus(status);
  } catch (err) {
    console.log('读取预生成状态失败:', err.message);
  }
}

async function retryPreload() {
  try {
    await window.wallpaperApi.resetPreloadBackoff();
    await refreshPreloadStatus();
    showMessage('已清除预生成暂停，将尽快重试', 'success');
  } catch (err) {
    showMessage('重试失败：' + err.message, 'error');
  }
}

// ---------- 错误横幅 ----------

function showApiError(payload) {
  const banner = el('apiErrorBanner');
  const text = el('apiErrorText');
  if (!banner || !text || !payload) return;
  const label = ROLE_LABELS[payload.role] || '接口';
  text.textContent = `[${label}] ${payload.message}`;
  banner.classList.add('show');
}

function dismissApiError() {
  const banner = el('apiErrorBanner');
  if (banner) banner.classList.remove('show');
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
  const presetEl = el('theme_preset');
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
    const node = el(id);
    if (node) {
      node.addEventListener('input', () => {
        document.documentElement.style.setProperty('--main-color', fieldValue('theme_main_color'));
        document.documentElement.style.setProperty('--main-color-hover', adjustColor(fieldValue('theme_main_color'), -20));
        document.documentElement.style.setProperty('--bg-color', fieldValue('theme_bg_color'));
        document.documentElement.style.setProperty('--card-bg', fieldValue('theme_card_bg'));
        document.documentElement.style.setProperty('--text-color', fieldValue('theme_text_color'));
        document.documentElement.style.setProperty('--text-secondary', fieldValue('theme_text_secondary'));
        document.documentElement.style.setProperty('--border-color', fieldValue('theme_border_color'));
        if (presetEl) presetEl.value = 'custom';
      });
    }
  });
}

// ---------- 轮流换显示器 ----------

function setupRotationEvents() {
  const resetBtn = el('rotationResetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      try {
        await window.wallpaperApi.resetDisplayRotation();
        showMessage('轮流顺序已重置，下次从第一台开始', 'success');
        refreshRotationStatus();
      } catch (err) {
        showMessage('重置失败：' + err.message, 'error');
      }
    });
  }
}

async function refreshRotationStatus() {
  const group = el('rotationGroup');
  const box = el('rotationStatus');
  if (!group || !box) return;

  // 只有选中「轮流更换」时才显示这块
  const selected = fieldValue('wallpaper_display');
  if (selected !== 'rotate') {
    group.style.display = 'none';
    return;
  }
  group.style.display = 'block';

  try {
    const info = await window.wallpaperApi.getDisplayRotation();
    if (!info || !info.total) {
      box.className = 'status-box warn';
      box.textContent = '没有检测到可用显示器';
      return;
    }
    const order = (info.list || []).map((d) => d.label).join(' → ');
    const next = info.next
      ? `下一次换到：${info.next.label}（${info.next.width}×${info.next.height}）`
      : '下一次换到：未知';
    if (info.total === 1) {
      box.className = 'status-box warn';
      box.textContent = `只检测到 1 台显示器（${order}），轮流效果与“仅主显示器”相同。\n${next}`;
      return;
    }
    box.className = 'status-box';
    box.textContent = `轮流顺序：${order}（共 ${info.total} 台）\n${next}`;
  } catch (err) {
    box.className = 'status-box';
    box.textContent = '读取轮流状态失败：' + err.message;
  }
}

// 当前壁纸预览（生成与换壁页）
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function loadPreview() {
  const imgEl = el('previewImg');
  const emptyEl = el('previewEmpty');
  const kwEl = el('previewKeywords');
  if (!imgEl || !emptyEl || !kwEl) return;
  try {
    await waitDbReady(); // 数据库没就绪时先等一下，避免误显示“暂无壁纸”
    const img = await window.wallpaperApi.getCurrentImage();
    if (!img || !img.fileUrl) {
      imgEl.style.display = 'none';
      imgEl.removeAttribute('src');
      emptyEl.style.display = 'block';
      emptyEl.textContent = '暂无壁纸，点击“立即换壁纸”生成';
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

// ---------- 启动 ----------

setupPageNav();
loadSettings();
setupIdleReset();
setupThemeListeners();
setupRateLimitEvents();
loadPreview();
setInterval(loadPreview, 10000);
setInterval(refreshPreloadStatus, 5000);
// 频率限制状态定期刷新（限制页可见时才有意义，顺手刷新也不贵）
setInterval(() => {
  const page = document.querySelector('section.page[data-page="ratelimit"]');
  if (page && page.classList.contains('active')) {
    PROFILE_ROLES.forEach((role) => refreshRateLimitStatus(role));
  }
}, 15000);
// 换壁纸后主进程会推送当前壁纸，立即刷新预览
window.wallpaperApi.onCurrentImage(() => loadPreview());
// 正式生成失败 / 预生成退避状态推送
window.wallpaperApi.onApiError((payload) => showApiError(payload));
window.wallpaperApi.onPreloadStatus((status) => renderPreloadStatus(status));

// 页脚“打开日志目录”：便携版没有控制台，日志是排查问题的唯一线索
const openLogDirLink = el('openLogDir');
if (openLogDirLink) {
  openLogDirLink.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const res = await window.wallpaperApi.openLogDir();
      if (!res || !res.success) {
        alert('打开日志目录失败：' + ((res && res.error) || '未知错误'));
      }
    } catch (err) {
      alert('打开日志目录失败：' + (err && err.message ? err.message : err));
    }
  });
}
