// lib/retention.js 的单元测试：图片最长保留期的“该删哪几行”判断
// 运行：npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { DAY_MS, selectExpiredImages } = require("../lib/retention");

const NOW = Date.parse("2026-11-11T00:00:00.000Z");
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();

test("超过保留期的记录都会被选中，与喜不喜欢无关", () => {
  const rows = [
    { id: 1, path: "E:/images/normal.png", created_at: daysAgo(31), status: "normal" },
    { id: 2, path: "E:/images/liked.png", created_at: daysAgo(31), status: "liked" },
    { id: 3, path: "E:/images/disliked.png", created_at: daysAgo(31), status: "disliked" },
    { id: 4, path: "E:/images/fresh.png", created_at: daysAgo(1), status: "normal" },
  ];
  const picked = selectExpiredImages(rows, { cutoffMs: NOW - 30 * DAY_MS });
  assert.deepEqual(picked.map((r) => r.id), [1, 2, 3]);
});

test("正好等于保留期边界不算过期（严格早于才删）", () => {
  const rows = [{ id: 1, path: "E:/images/a.png", created_at: daysAgo(30) }];
  const picked = selectExpiredImages(rows, { cutoffMs: NOW - 30 * DAY_MS });
  assert.equal(picked.length, 0);
});

test("当前正显示的壁纸路径受保护，即使早已过期", () => {
  const rows = [
    { id: 1, path: "E:/images/current.png", created_at: daysAgo(999) },
    { id: 2, path: "E:/images/other.PNG", created_at: daysAgo(999) },
  ];
  const picked = selectExpiredImages(rows, {
    cutoffMs: NOW - 30 * DAY_MS,
    protectedPaths: new Set(["e:/images/current.png"]),
  });
  assert.deepEqual(picked.map((r) => r.id), [2]);
});

test("无法判断年龄的记录不删（宁可漏删不误删）", () => {
  const rows = [
    { id: 1, path: "E:/images/x.png", created_at: "not-a-date" },
    { id: 2, path: "E:/images/y.png", created_at: "" },
    { id: 3, path: "E:/images/z.png" },
  ];
  const picked = selectExpiredImages(rows, { cutoffMs: NOW - 30 * DAY_MS });
  assert.equal(picked.length, 0);
});

test("自定义 getAgeMs 生效：老数据可用文件修改时间兜底", () => {
  const rows = [
    { id: 1, path: "E:/images/old.png", created_at: "" },
    { id: 2, path: "E:/images/new.png", created_at: "" },
  ];
  const picked = selectExpiredImages(rows, {
    cutoffMs: NOW - 30 * DAY_MS,
    getAgeMs: (row) => (row.id === 1 ? NOW - 40 * DAY_MS : NOW - 2 * DAY_MS),
  });
  assert.deepEqual(picked.map((r) => r.id), [1]);
});

test("非法入参返回空数组，不抛异常", () => {
  assert.deepEqual(selectExpiredImages(null, { cutoffMs: NOW }), []);
  assert.deepEqual(selectExpiredImages([{ id: 1, created_at: daysAgo(999) }], {}), []);
  assert.deepEqual(selectExpiredImages([{ path: "a" }], { cutoffMs: NOW }), []);
});
