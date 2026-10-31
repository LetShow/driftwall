// LLM / 文生图适配层（见 ADR-011）
// 这里只做"怎么发、怎么读"的纯逻辑，不依赖 Electron，便于 test/ 下用假服务器验证。
//
// 术语：
// - Profile：一组完整接口配置（模板 + 地址 + Key + 认证 + 请求体覆盖 + 响应取值）
// - 模板：只提供默认值，地址和 Key 永远由用户填写

const AUTH_TYPES = ["bearer", "x-api-key", "api-key", "query", "none"];

// 各模板的默认值。body 里的 {{...}} 在发送前替换。
const TEMPLATES = {
  "openai-compatible": {
    label: "OpenAI 兼容（含各类中转站）",
    roles: ["llm", "image"],
    llm: {
      auth: "bearer",
      body: {
        model: "{{model}}",
        messages: "{{messages}}",
        max_tokens: 512,
        temperature: 1.0,
      },
      responsePath: "choices[0].message.content",
    },
    image: {
      auth: "bearer",
      body: {
        model: "{{model}}",
        prompt: "{{prompt}}",
        size: "{{size}}",
        n: 1,
      },
      responsePath: "data[0].url",
      sizeTiers: ["1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"],
    },
  },
  "azure-openai": {
    label: "Azure OpenAI",
    roles: ["llm", "image"],
    llm: {
      auth: "api-key",
      body: { messages: "{{messages}}", max_tokens: 512, temperature: 1.0 },
      responsePath: "choices[0].message.content",
    },
    image: {
      auth: "api-key",
      body: { prompt: "{{prompt}}", size: "{{size}}", n: 1 },
      responsePath: "data[0].url",
      sizeTiers: ["1024x1024", "1792x1024", "1024x1792"],
    },
  },
  "sd-webui": {
    label: "Stable Diffusion WebUI（本地）",
    roles: ["image"],
    image: {
      auth: "none",
      body: {
        prompt: "{{prompt}}",
        negative_prompt: "",
        width: "{{width}}",
        height: "{{height}}",
        steps: 25,
        batch_size: 1,
      },
      responsePath: "images[0]",
      sizeTiers: ["1024x1024", "1280x720", "1920x1080", "1080x1920"],
    },
  },
  "custom-json": {
    label: "自定义 JSON",
    roles: ["llm", "image"],
    llm: {
      auth: "bearer",
      body: { model: "{{model}}", messages: "{{messages}}" },
      responsePath: "choices[0].message.content",
    },
    image: {
      auth: "bearer",
      body: { prompt: "{{prompt}}" },
      responsePath: "data[0].url",
    },
  },
};

const DEFAULT_POLL = {
  enabled: false,
  url: "",
  method: "GET",
  body: {},
  taskIdPath: "",
  statusPath: "",
  successValues: "succeeded,success,completed,SUCCEEDED",
  failValues: "failed,error,cancelled",
  resultPath: "",
  intervalSec: 5,
  timeoutSec: 300,
};

// 模板列表（按角色），给设置页渲染下拉用
function listTemplates(role) {
  return Object.keys(TEMPLATES)
    .filter((id) => (TEMPLATES[id].roles || []).includes(role))
    .map((id) => ({ id, label: TEMPLATES[id].label }));
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// 深合并：数组整体替换，对象递归，其余覆盖
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return clone(override === undefined ? base : override);
  }
  const out = clone(base) || {};
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}

function parseMaybeJson(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

function templateIds(role) {
  return Object.keys(TEMPLATES).filter((id) =>
    (TEMPLATES[id].roles || []).includes(role),
  );
}

function pickTemplate(role, template) {
  if (template && TEMPLATES[template] && TEMPLATES[template][role]) {
    return template;
  }
  return templateIds(role)[0];
}

// 某个角色 + 模板的默认 profile（设置页切换模板时用它填充高级区）
function defaultProfile(role, template) {
  const tplId = pickTemplate(role, template);
  const tpl = TEMPLATES[tplId][role];
  return normalizeProfile(role, {
    template: tplId,
    auth: tpl.auth,
    body: clone(tpl.body),
    responsePath: tpl.responsePath,
    sizeTiers: clone(tpl.sizeTiers),
  });
}

// 把用户存下来的任意 JSON 收敛成完整可用的 profile
function normalizeProfile(role, raw) {
  const input = isPlainObject(raw) ? raw : parseMaybeJson(raw, {});
  const tplId = pickTemplate(role, input.template);
  const tpl = TEMPLATES[tplId][role] || {};

  const auth = AUTH_TYPES.includes(input.auth) ? input.auth : tpl.auth || "bearer";
  const pollInput = isPlainObject(input.poll)
    ? input.poll
    : parseMaybeJson(input.poll, {});
  const poll = deepMerge(DEFAULT_POLL, {
    ...pollInput,
    method: String(pollInput.method || DEFAULT_POLL.method).toUpperCase(),
  });

  const headersInput = parseMaybeJson(input.headers, {});
  return {
    template: tplId,
    url: String(input.url || "").trim(),
    key: String(input.key || ""),
    model: String(input.model || ""),
    auth,
    authParam: String(input.authParam || "key"),
    headers: isPlainObject(headersInput) ? headersInput : {},
    body: deepMerge(tpl.body || {}, parseMaybeJson(input.body, {})),
    responsePath:
      input.responsePath !== undefined
        ? String(input.responsePath)
        : tpl.responsePath || "",
    sizeTiers: Array.isArray(input.sizeTiers)
      ? input.sizeTiers.map(String)
      : clone(tpl.sizeTiers) || [],
    sizeMode: ["auto", "custom", "none"].includes(input.sizeMode)
      ? input.sizeMode
      : "auto",
    customSize: String(input.customSize || ""),
    downloadWithAuth: !!input.downloadWithAuth,
    timeoutSec: Number(input.timeoutSec) > 0 ? Number(input.timeoutSec) : 0,
    poll,
  };
}

// ---------- JSON 路径 ----------
// 支持 a.b[0].c、a["b"].c、images[0] 这类写法
function parsePath(path) {
  const tokens = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\[['"]([^'"]+)['"]\]/g;
  let m;
  while ((m = re.exec(String(path || ""))) !== null) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(Number(m[2]));
    else if (m[3] !== undefined) tokens.push(m[3]);
  }
  return tokens;
}

function pathGet(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const t of parsePath(path)) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[t];
  }
  return cur;
}

// ---------- 占位符替换 ----------
function applyVars(value, vars) {
  if (typeof value === "string") {
    const whole = value.match(/^\s*\{\{(\w+)\}\}\s*$/);
    if (whole && Object.prototype.hasOwnProperty.call(vars, whole[1])) {
      return clone(vars[whole[1]]);
    }
    return value.replace(/\{\{(\w+)\}\}/g, (raw, name) =>
      Object.prototype.hasOwnProperty.call(vars, name)
        ? String(vars[name] === undefined || vars[name] === null ? "" : vars[name])
        : raw,
    );
  }
  if (Array.isArray(value)) return value.map((v) => applyVars(v, vars));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = applyVars(v, vars);
    return out;
  }
  return value;
}

// ---------- 尺寸 ----------
function parseSize(size) {
  const m = String(size || "").match(/^(\d+)\s*[xX*]\s*(\d+)$/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

function ratioNumber(ratio) {
  if (typeof ratio === "number" && ratio > 0) return ratio;
  const m = String(ratio || "").match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!m || Number(m[2]) === 0) return 16 / 9;
  return Number(m[1]) / Number(m[2]);
}

// 按屏幕比例挑最接近的一档；没有档位时返回空字符串
function pickSize(tiers, ratio) {
  const target = ratioNumber(ratio);
  const usable = (tiers || []).map(parseSize).filter(Boolean);
  if (usable.length === 0) return "";
  let best = usable[0];
  let bestScore = Infinity;
  for (const t of usable) {
    const score = Math.abs(Math.log(t.width / t.height / target));
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return `${best.width}x${best.height}`;
}

function resolveSize(profile, ratio) {
  if (profile.sizeMode === "custom" && parseSize(profile.customSize)) {
    return profile.customSize;
  }
  if (profile.sizeMode === "none") return "";
  return pickSize(profile.sizeTiers, ratio);
}

// ---------- 认证与请求 ----------
function authHeaders(profile) {
  const key = profile.key || "";
  if (!key || profile.auth === "none") return {};
  if (profile.auth === "bearer") return { Authorization: `Bearer ${key}` };
  if (profile.auth === "x-api-key") return { "x-api-key": key };
  if (profile.auth === "api-key") return { "api-key": key };
  return {};
}

function withQueryKey(url, profile) {
  if (profile.auth !== "query" || !profile.key) return url;
  const sep = String(url).includes("?") ? "&" : "?";
  return `${url}${sep}${encodeURIComponent(profile.authParam || "key")}=${encodeURIComponent(profile.key)}`;
}

function buildVars(role, profile, payload) {
  const size = role === "image" ? resolveSize(profile, payload.ratio) : "";
  const parsed = parseSize(size) || { width: "", height: "" };
  return {
    model: profile.model || "",
    prompt: payload.prompt || "",
    messages: payload.messages || [],
    size,
    ratio: payload.ratio || "",
    width: parsed.width,
    height: parsed.height,
    key: profile.key || "",
  };
}

// 生成一次请求配置（axios 可直接用）
function planRequest(role, profile, payload) {
  if (!profile.url) throw new Error("接口地址为空");
  const vars = buildVars(role, profile, payload || {});
  const headers = {
    "Content-Type": "application/json",
    ...(isPlainObject(profile.headers) ? applyVars(profile.headers, vars) : {}),
    ...authHeaders(profile),
  };
  return {
    url: withQueryKey(profile.url, profile),
    method: "POST",
    headers,
    data: applyVars(profile.body, vars),
  };
}

// 轮询请求
function planPollRequest(profile, taskId) {
  const poll = profile.poll || DEFAULT_POLL;
  if (!poll.url) throw new Error("轮询地址为空");
  const vars = { taskId, key: profile.key || "" };
  return {
    url: withQueryKey(String(poll.url).replace(/\{\{taskId\}\}/g, encodeURIComponent(taskId)), profile),
    method: String(poll.method || "GET").toUpperCase(),
    headers: {
      "Content-Type": "application/json",
      ...(isPlainObject(profile.headers) ? applyVars(profile.headers, vars) : {}),
      ...authHeaders(profile),
    },
    data: applyVars(poll.body || {}, vars),
  };
}

// ---------- 响应解析 ----------
function extractText(data, profile) {
  const v = pathGet(data, profile.responsePath);
  if (v === undefined || v === null || v === "") {
    throw new Error(`响应里找不到提示词字段（${profile.responsePath || "未配置"}）`);
  }
  if (Array.isArray(v)) return v.map(String).join("\n");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || ""));
}

function looksLikeBase64(s) {
  const str = String(s || "").replace(/\s+/g, "");
  return str.length > 64 && /^[A-Za-z0-9+/=]+$/.test(str);
}

function stripDataUri(s) {
  return String(s).replace(/^data:[^;]+;base64,/, "");
}

// 从纯文本里抓 Markdown / 裸图片链接（部分中转站把图塞在 chat 回复里）
function extractImageUrlFromText(text) {
  const src = String(text || "");
  const md = src.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i);
  if (md) return md[1];
  const bare = src.match(/https?:\/\/[^\s"'<>)]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>)]*)?/i);
  return bare ? bare[0] : "";
}

// 把某个值归一成图片结果
function normalizeImageValue(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return normalizeImageValue(v[0]);
  if (Buffer.isBuffer(v)) return { kind: "bytes", value: v };
  if (typeof v === "object") {
    if (v.b64_json) return { kind: "base64", value: v.b64_json };
    if (v.base64) return { kind: "base64", value: v.base64 };
    if (v.url) return normalizeImageValue(v.url);
    if (v.image_url) return normalizeImageValue(v.image_url);
    if (v.image) return normalizeImageValue(v.image);
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  if (isHttpUrl(s)) return { kind: "url", value: s };
  if (/^data:image\//i.test(s) || looksLikeBase64(s)) {
    return { kind: "base64", value: stripDataUri(s) };
  }
  const fromText = extractImageUrlFromText(s);
  if (fromText) return { kind: "url", value: fromText };
  return null;
}

function findFirstUrl(obj, depth = 0) {
  if (depth > 4 || obj === null || obj === undefined) return "";
  if (typeof obj === "string") {
    if (isHttpUrl(obj)) return obj;
    const t = extractImageUrlFromText(obj);
    return t || "";
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findFirstUrl(v, depth + 1);
      if (r) return r;
    }
    return "";
  }
  if (isPlainObject(obj)) {
    for (const k of ["url", "image_url", "image", "output", "result", "data"]) {
      if (obj[k] !== undefined) {
        const r = findFirstUrl(obj[k], depth + 1);
        if (r) return r;
      }
    }
    for (const v of Object.values(obj)) {
      const r = findFirstUrl(v, depth + 1);
      if (r) return r;
    }
  }
  return "";
}

// 解析直接返回的图片响应。失败时抛错；异步任务返回 { kind: "task" }
function extractImage(data, profile) {
  const direct = normalizeImageValue(pathGet(data, profile.responsePath));
  if (direct) return direct;

  const poll = profile.poll || DEFAULT_POLL;
  if (poll.enabled && poll.url) {
    const candidates = [
      poll.taskIdPath,
      "task_id",
      "data.task_id",
      "id",
      "data.id",
      "taskId",
      "request_id",
    ].filter(Boolean);
    for (const p of candidates) {
      const v = pathGet(data, p);
      if (v !== undefined && v !== null && String(v) !== "") {
        return { kind: "task", taskId: String(v) };
      }
    }
    throw new Error("已配置轮询，但响应里找不到任务 ID");
  }

  const url = findFirstUrl(data);
  if (url) return { kind: "url", value: url };

  throw new Error(
    `响应里找不到图片（取值路径 ${profile.responsePath || "未配置"}）`,
  );
}

// 轮询结果：{ state: "pending"|"success"|"failed", status, image? }
function pollStep(profile, data) {
  const poll = profile.poll || DEFAULT_POLL;
  const statusRaw = poll.statusPath ? pathGet(data, poll.statusPath) : undefined;
  const status = statusRaw === undefined ? "" : String(statusRaw).toLowerCase();
  const successValues = String(poll.successValues || "")
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const failValues = String(poll.failValues || "")
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  if (status && failValues.includes(status)) {
    return { state: "failed", status };
  }
  if (status && successValues.includes(status)) {
    const image =
      normalizeImageValue(pathGet(data, poll.resultPath)) ||
      normalizeImageValue(pathGet(data, profile.responsePath)) ||
      normalizeImageValue(findFirstUrl(data));
    if (image) return { state: "success", status, image };
    return { state: "pending", status };
  }

  // 没配状态字段时：能直接取到图片就算完成
  if (!poll.statusPath) {
    const image = normalizeImageValue(pathGet(data, poll.resultPath));
    if (image) return { state: "success", status: status || "unknown", image };
  }
  return { state: "pending", status };
}

// 按响应头 / 文件魔数决定扩展名（不再一律 .png）
function guessImageExtension(contentType, buffer) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return "jpg";
  if (ct.includes("image/webp")) return "webp";
  if (ct.includes("image/gif")) return "gif";
  if (ct.includes("image/avif")) return "avif";
  if (ct.includes("image/png")) return "png";
  const b = buffer || Buffer.alloc(0);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b.length >= 4 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  if (b.length >= 3 && b.toString("ascii", 0, 3) === "GIF") return "gif";
  return "png";
}

// 兼容 JSON 与二进制响应：二进制会包成 { __binary, contentType }
function parseResponseBody(resp) {
  const data = resp ? resp.data : undefined;
  const headers = (resp && resp.headers) || {};
  const contentType = String(headers["content-type"] || "").toLowerCase();

  const parseText = (text) => {
    const trimmed = String(text || "").trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        return trimmed;
      }
    }
    return trimmed;
  };

  if (Buffer.isBuffer(data)) {
    if (contentType.includes("json") || contentType.includes("text") || contentType.includes("xml")) {
      return parseText(data.toString("utf8"));
    }
    if (contentType.startsWith("image/")) {
      return { __binary: data, contentType };
    }
    const head = data.toString("utf8", 0, 1);
    if (head === "{" || head === "[") {
      try {
        return JSON.parse(data.toString("utf8"));
      } catch (e) {
        return data.toString("utf8");
      }
    }
    return { __binary: data, contentType };
  }

  if (typeof data === "string") {
    if (contentType.startsWith("image/")) {
      return { __binary: Buffer.from(data, "binary"), contentType };
    }
    return parseText(data);
  }

  return data;
}

// 判断错误是否值得重试：超时 / 网络 / 5xx 重试，4xx 不重试
function isRetryableError(err) {
  const status = err && err.response && err.response.status;
  if (status) return status >= 500;
  const code = err && (err.code || "");
  return (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ERR_NETWORK" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN"
  );
}

module.exports = {
  AUTH_TYPES,
  TEMPLATES,
  DEFAULT_POLL,
  listTemplates,
  templateIds,
  defaultProfile,
  normalizeProfile,
  deepMerge,
  applyVars,
  parsePath,
  pathGet,
  parseSize,
  pickSize,
  ratioNumber,
  resolveSize,
  planRequest,
  planPollRequest,
  extractText,
  extractImage,
  pollStep,
  normalizeImageValue,
  extractImageUrlFromText,
  guessImageExtension,
  parseResponseBody,
  isRetryableError,
  authHeaders,
  withQueryKey,
};
