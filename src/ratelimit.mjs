/**
 * 单机内存滑动窗口限流。
 *
 * 注意：进程内计数，多实例部署时各实例独立计数；需要全局限额时应换成
 * Redis/网关限流。默认只对 /api/* 与登录端点启用，可通过环境变量关闭。
 *
 * @param {object} options
 * @param {number} options.windowMs 窗口长度（毫秒）
 * @param {number} options.max 窗口内允许的请求数
 * @param {() => number} options.now 注入时钟（测试用）
 */
export function createRateLimiter({ windowMs = 60_000, max = 300, now = Date.now } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error(`windowMs 不合法：${windowMs}`);
  if (!Number.isFinite(max) || max <= 0) throw new Error(`max 不合法：${max}`);
  const buckets = new Map();

  function hit(key) {
    const t = now();
    const arr = (buckets.get(key) || []).filter((ts) => t - ts < windowMs);
    const allowed = arr.length < max;
    if (allowed) arr.push(t);
    buckets.set(key, arr);
    const retryAfterMs = allowed ? 0 : Math.max(0, windowMs - (t - arr[0]));
    return {
      allowed,
      remaining: Math.max(0, max - arr.length),
      retryAfterMs,
      resetAt: arr[0] ? arr[0] + windowMs : t + windowMs,
    };
  }

  function prune() {
    const t = now();
    for (const [key, arr] of buckets) {
      if (!arr.length || t - arr[arr.length - 1] >= windowMs) buckets.delete(key);
    }
  }

  return {
    windowMs,
    max,
    hit,
    prune,
    get size() {
      return buckets.size;
    },
  };
}

/**
 * 取请求来源 IP。默认只信任 socket 地址；trustProxy=true 时读取
 * X-Forwarded-For 的第一个地址（必须部署在可信反向代理之后）。
 */
export function requestIp(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}
