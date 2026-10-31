// 离线验证适配层（ADR-011 验收方式）
// 运行：npm test
// 覆盖：4 种返回形态（url / b64_json / 二进制 / 异步轮询）+ 4 种认证 + chat 内嵌图片
// 不访问任何真实服务，也不需要 Key。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const axios = require("axios");
const adapters = require("../lib/adapters");

// 1x1 透明 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let server;
let base;
let pollCount = 0;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = await readBody(req);

    if (url.pathname === "/echo") {
      return sendJson(res, {
        authorization: req.headers.authorization || "",
        xApiKey: req.headers["x-api-key"] || "",
        apiKey: req.headers["api-key"] || "",
        queryKey: url.searchParams.get("key") || "",
        contentType: req.headers["content-type"] || "",
        parsedBody: body ? JSON.parse(body) : null,
      });
    }

    if (url.pathname === "/img/url") {
      return sendJson(res, { data: [{ url: `${base}/file.png` }] });
    }

    if (url.pathname === "/img/b64") {
      return sendJson(res, { data: [{ b64_json: PNG.toString("base64") }] });
    }

    if (url.pathname === "/img/binary") {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": PNG.length,
      });
      return res.end(PNG);
    }

    if (url.pathname === "/chat") {
      return sendJson(res, {
        choices: [
          {
            message: {
              content: `Sure, here you go:\n![wallpaper](${base}/file.png)\nHope you like it.`,
            },
          },
        ],
      });
    }

    if (url.pathname === "/task" && req.method === "POST") {
      pollCount = 0;
      return sendJson(res, { data: { task_id: "task-1" } });
    }

    if (url.pathname === "/task/task-1") {
      pollCount += 1;
      if (pollCount < 2) {
        return sendJson(res, { data: { status: "running" } });
      }
      return sendJson(res, {
        data: { status: "succeeded", result: { url: `${base}/file.png` } },
      });
    }

    if (url.pathname === "/file.png") {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": PNG.length,
      });
      return res.end(PNG);
    }

    return sendJson(res, { error: { message: "not found" } }, 404);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  if (server) server.close();
});

function makeProfile(overrides) {
  return adapters.normalizeProfile("llm", {
    template: "openai-compatible",
    url: `${base}/echo`,
    key: "test-key",
    model: "test-model",
    ...overrides,
  });
}

// ---------- 认证 ----------

test("认证方式：bearer / x-api-key / api-key / query 都发到正确位置", async () => {
  const cases = [
    { auth: "bearer", assert: (d) => assert.equal(d.authorization, "Bearer test-key") },
    { auth: "x-api-key", assert: (d) => assert.equal(d.xApiKey, "test-key") },
    { auth: "api-key", assert: (d) => assert.equal(d.apiKey, "test-key") },
    {
      auth: "query",
      assert: (d) => {
        assert.equal(d.queryKey, "test-key");
        assert.equal(d.authorization, "");
      },
    },
  ];

  for (const item of cases) {
    const profile = makeProfile({ auth: item.auth, authParam: "key" });
    const req = adapters.planRequest("llm", profile, {
      messages: [{ role: "user", content: "hi" }],
    });
    const resp = await axios.request(req);
    item.assert(resp.data);
  }
});

test("认证方式 none：不发送任何 Key", async () => {
  const profile = makeProfile({ auth: "none" });
  const req = adapters.planRequest("llm", profile, { messages: [] });
  const resp = await axios.request(req);
  assert.equal(resp.data.authorization, "");
  assert.equal(resp.data.queryKey, "");
});

// ---------- 返回形态 ----------

test("返回形态 url：解析出链接，下载后按 Content-Type 识别为 png", async () => {
  const profile = makeProfile({
    template: "openai-compatible",
    url: `${base}/img/url`,
    responsePath: "data[0].url",
  });
  const req = adapters.planRequest("image", profile, {
    prompt: "test",
    ratio: "16:9",
  });
  const resp = await axios.request(req);
  const image = adapters.extractImage(resp.data, profile);
  assert.equal(image.kind, "url");
  assert.equal(image.value, `${base}/file.png`);

  const download = await axios.get(image.value, { responseType: "arraybuffer" });
  const parsed = adapters.parseResponseBody(download);
  assert.ok(Buffer.isBuffer(parsed.__binary));
  assert.equal(parsed.__binary.length, PNG.length);
  assert.equal(adapters.guessImageExtension(parsed.contentType, parsed.__binary), "png");
});

test("返回形态 b64_json：解析出 base64 并识别为 png", async () => {
  const profile = makeProfile({
    template: "openai-compatible",
    url: `${base}/img/b64`,
    responsePath: "data[0].b64_json",
  });
  const req = adapters.planRequest("image", profile, { prompt: "test" });
  const resp = await axios.request(req);
  const image = adapters.extractImage(resp.data, profile);
  assert.equal(image.kind, "base64");
  const buffer = Buffer.from(image.value, "base64");
  assert.deepEqual(buffer, PNG);
  assert.equal(adapters.guessImageExtension("", buffer), "png");
});

test("返回形态二进制：POST 直接返回图片流", async () => {
  const profile = makeProfile({
    template: "openai-compatible",
    url: `${base}/img/binary`,
    responsePath: "",
  });
  const req = adapters.planRequest("image", profile, { prompt: "test" });
  const resp = await axios.request({ ...req, responseType: "arraybuffer" });
  const parsed = adapters.parseResponseBody(resp);
  assert.ok(Buffer.isBuffer(parsed.__binary));
  assert.deepEqual(parsed.__binary, PNG);
  assert.equal(adapters.guessImageExtension(parsed.contentType, parsed.__binary), "png");
});

test("返回形态异步任务：提取任务 ID，轮询 pending → success", async () => {
  const profile = makeProfile({
    template: "openai-compatible",
    url: `${base}/task`,
    responsePath: "data[0].url",
    poll: {
      enabled: true,
      url: `${base}/task/{{taskId}}`,
      method: "GET",
      taskIdPath: "data.task_id",
      statusPath: "data.status",
      successValues: "succeeded,success",
      failValues: "failed,error",
      resultPath: "data.result.url",
      intervalSec: 1,
      timeoutSec: 10,
    },
  });

  const req = adapters.planRequest("image", profile, { prompt: "test" });
  const resp = await axios.request(req);
  const task = adapters.extractImage(resp.data, profile);
  assert.deepEqual(task, { kind: "task", taskId: "task-1" });

  const pollReq = adapters.planPollRequest(profile, task.taskId);
  assert.equal(pollReq.url, `${base}/task/task-1`);

  const first = adapters.pollStep(profile, (await axios.request(pollReq)).data);
  assert.equal(first.state, "pending");

  const second = adapters.pollStep(profile, (await axios.request(pollReq)).data);
  assert.equal(second.state, "success");
  assert.equal(second.image.kind, "url");
  assert.equal(second.image.value, `${base}/file.png`);
});

test("返回形态 chat 内嵌 Markdown：提取提示词与图片链接", async () => {
  const profile = makeProfile({
    url: `${base}/chat`,
    responsePath: "choices[0].message.content",
  });
  const req = adapters.planRequest("llm", profile, {
    messages: [{ role: "user", content: "hi" }],
  });
  const resp = await axios.request(req);
  const text = adapters.extractText(resp.data, profile);
  assert.match(text, /wallpaper/);
  assert.equal(adapters.extractImageUrlFromText(text), `${base}/file.png`);
});

// ---------- 配置与工具 ----------

test("请求体深合并：用户字段覆盖模板，数组整体替换", () => {
  const profile = adapters.normalizeProfile("image", {
    template: "openai-compatible",
    url: `${base}/echo`,
    body: { size: "1024x1024", extra_body: { response_format: "b64_json" } },
  });
  assert.equal(profile.body.prompt, "{{prompt}}");
  assert.equal(profile.body.size, "1024x1024");
  assert.equal(profile.body.extra_body.response_format, "b64_json");

  const req = adapters.planRequest("image", profile, {
    prompt: "hello",
    ratio: "16:9",
  });
  assert.equal(req.data.prompt, "hello");
  assert.equal(req.data.size, "1024x1024");
});

test("尺寸：按比例选最接近档位，自定义尺寸覆盖，none 不发送", () => {
  const tiers = ["1024x1024", "1536x1024", "1024x1536", "1792x1024"];
  assert.equal(adapters.pickSize(tiers, "16:9"), "1792x1024");
  assert.equal(adapters.pickSize(tiers, "9:16"), "1024x1536");
  assert.equal(adapters.pickSize(tiers, "1:1"), "1024x1024");
  assert.equal(adapters.pickSize([], "16:9"), "");

  const custom = adapters.normalizeProfile("image", {
    template: "openai-compatible",
    sizeMode: "custom",
    customSize: "2560x1440",
  });
  assert.equal(adapters.resolveSize(custom, "16:9"), "2560x1440");

  const none = adapters.normalizeProfile("image", {
    template: "openai-compatible",
    sizeMode: "none",
  });
  assert.equal(adapters.resolveSize(none, "16:9"), "");
});

test("错误重试判定：5xx / 超时重试，4xx 不重试", () => {
  assert.equal(adapters.isRetryableError({ response: { status: 500 } }), true);
  assert.equal(adapters.isRetryableError({ response: { status: 503 } }), true);
  assert.equal(adapters.isRetryableError({ response: { status: 400 } }), false);
  assert.equal(adapters.isRetryableError({ response: { status: 401 } }), false);
  assert.equal(adapters.isRetryableError({ code: "ECONNABORTED" }), true);
  assert.equal(adapters.isRetryableError({ code: "ETIMEDOUT" }), true);
  assert.equal(adapters.isRetryableError({ code: "ERR_BAD_REQUEST" }), false);
});

test("JSON 路径：点号、数组下标、带引号键", () => {
  const data = { data: [{ result: { url: "u" } }], "a-b": { c: 1 } };
  assert.equal(adapters.pathGet(data, "data[0].result.url"), "u");
  assert.equal(adapters.pathGet(data, "['a-b'].c"), 1);
  assert.equal(adapters.pathGet(data, "missing.path"), undefined);
});

test("归一化：未知模板回退、非法认证回退、轮询默认值补齐", () => {
  const profile = adapters.normalizeProfile("image", {
    template: "not-exist",
    auth: "weird",
    poll: { enabled: true, url: "x" },
  });
  assert.equal(profile.template, "openai-compatible");
  assert.equal(profile.auth, "bearer");
  assert.equal(profile.poll.method, "GET");
  assert.equal(profile.poll.intervalSec, 5);
  assert.equal(profile.poll.timeoutSec, 300);
});
