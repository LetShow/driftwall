// 图片最长保留期（设置项 image_max_age_days，0 = 永久保留）
// 超过该天数的图片无论 normal / liked / disliked 都要删除，让图库持续换血，
// 桌面壁纸才可能永远换到新图——喜欢过的图若永久保留，最终会占满图库、
// 反复被抽中，换壁纸也就名存实亡。这里只做「挑出该删哪几行」的判断，
// 删文件、删记录、保护当前壁纸由调用方（main.js）负责。

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 挑出已超过保留期、可以删除的图片记录。
 *
 * @param {Array<{id:number, path?:string, created_at?:string}>} rows 全部图片记录
 * @param {object} opts
 * @param {number} opts.cutoffMs 时间戳，早于（严格小于）它的记录才算过期
 * @param {Set<string>} [opts.protectedPaths] 受保护路径（小写），当前正显示的壁纸永不删除
 * @param {(row:object) => number|null} [opts.getAgeMs] 计算记录年龄的时间戳，
 *        返回 null / NaN 表示无法判断年龄（宁可漏删也不误删）
 * @returns {Array} 应被删除的记录，顺序与入参一致
 */
function selectExpiredImages(rows, { cutoffMs, protectedPaths, getAgeMs } = {}) {
  if (!Array.isArray(rows) || !Number.isFinite(cutoffMs)) return [];
  const protectedSet = protectedPaths instanceof Set ? protectedPaths : new Set();

  const out = [];
  for (const row of rows) {
    if (!row || row.id === undefined || row.id === null) continue;

    const key = String(row.path || "").trim().toLowerCase();
    if (key && protectedSet.has(key)) continue;

    const age =
      typeof getAgeMs === "function"
        ? getAgeMs(row)
        : Date.parse(row.created_at || "");
    if (typeof age !== "number" || !Number.isFinite(age)) continue;
    if (age >= cutoffMs) continue;

    out.push(row);
  }
  return out;
}

module.exports = { DAY_MS, selectExpiredImages };
