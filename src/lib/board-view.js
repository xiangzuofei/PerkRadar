import { BOARD_MAX_ITEMS, MAX_URL_CHARS, SUMMARY_MAX, TITLE_MAX } from "./config.js";
import { CATEGORIES } from "./types.js";
/** 客户端边界校验：接口、SSR 快照和刷新结果都按不可信输入处理，坏字段不能让页面崩溃。 */
// 与服务端入库边界保持一致：URL 2048 字、单轮最多 2000 条，异常响应也按同一上限截断。
const URL_MAX = MAX_URL_CHARS;
const LIST_MAX = BOARD_MAX_ITEMS;
// 北京时间标签约 16 字；来源名、ID 和错误说明留到 80 字足够，只是展示上限，不改数据库。
const SHORT_MAX = 80;
const ERROR_MAX = SUMMARY_MAX;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function limit(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(4000, Math.floor(value)));
}
function scalarText(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    return "";
}
/** 去掉控制字符、折叠空白并截断展示文本；不补写内容，也不把 HTML 当可执行代码。 */
export function safeDisplayText(value, max) {
    const cleaned = scalarText(value)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned.slice(0, limit(max));
}
/** 与 safeDisplayText 同一套边界，供短标签、ID 和来源名复用。 */
export function clampText(value, max) {
    return safeDisplayText(value, max);
}
function nullableText(value, max) {
    if (typeof value !== "string")
        return null;
    return safeDisplayText(value, max) || null;
}
function finiteNumber(value, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function nullableNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function count(value, fallback = 0) {
    return Math.max(0, Math.floor(finiteNumber(value, fallback)));
}
function boolean(value, fallback = false) {
    return typeof value === "boolean" ? value : fallback;
}
function stringList(value, maxItems, maxChars) {
    if (!Array.isArray(value))
        return [];
    const result = [];
    for (const item of value.slice(0, maxItems)) {
        // 异常提示只接受字符串；把数字 42 变成「42」会伪造一条并不存在的提示。
        if (typeof item !== "string")
            continue;
        const text = safeDisplayText(item, maxChars);
        if (text)
            result.push(text);
    }
    return result;
}
/** 只保留可点击的 http(s) 原文链接；null 只表示「没有可用安全链接」，不是请求失败。 */
export function safeHttpUrl(value) {
    if (typeof value !== "string")
        return null;
    const raw = value.trim();
    if (!raw || raw.length > URL_MAX || /[\u0000-\u001f\u007f]/.test(raw))
        return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return null;
        if (url.username || url.password)
            return null;
        if (url.href.length > URL_MAX)
            return null;
        return url.href;
    }
    catch {
        return null;
    }
}
function categoryOf(value) {
    const raw = typeof value === "string" ? value : "";
    return CATEGORIES.includes(raw) ? raw : "其他";
}
function normalizeDeal(value) {
    if (!isRecord(value))
        return null;
    const canonicalUrl = safeHttpUrl(value.canonicalUrl);
    if (!canonicalUrl)
        return null;
    return {
        id: count(value.id),
        url: safeHttpUrl(value.url) ?? canonicalUrl,
        canonicalUrl,
        title: safeDisplayText(value.title, TITLE_MAX),
        summary: safeDisplayText(value.summary, SUMMARY_MAX),
        image: safeHttpUrl(value.image),
        category: categoryOf(value.category),
        sourceId: clampText(value.sourceId, SHORT_MAX),
        sourceName: clampText(value.sourceName, SHORT_MAX),
        publishedAt: nullableNumber(value.publishedAt),
        expiresAt: nullableNumber(value.expiresAt),
        publishedLabel: nullableText(value.publishedLabel, SHORT_MAX),
        expiresLabel: nullableText(value.expiresLabel, SHORT_MAX),
        expiresSoon: boolean(value.expiresSoon),
        isNew: boolean(value.isNew),
    };
}
function normalizeSourceQuality(value) {
    if (!isRecord(value))
        return undefined;
    const consecutiveFailures = count(value.consecutiveFailures);
    const countDrop = typeof value.countDrop === "boolean" ? value.countDrop : false;
    const structureAnomaly = typeof value.structureAnomaly === "boolean" ? value.structureAnomaly : false;
    const warning = nullableText(value.warning, ERROR_MAX);
    if (consecutiveFailures === 0 && !countDrop && !structureAnomaly && warning == null)
        return undefined;
    return { consecutiveFailures, countDrop, structureAnomaly, warning };
}
function normalizeSource(value) {
    if (!isRecord(value))
        return null;
    const id = clampText(value.id, SHORT_MAX);
    if (!id)
        return null;
    return {
        id,
        name: clampText(value.name, SHORT_MAX) || id,
        activeCount: count(value.activeCount),
        lastOk: typeof value.lastOk === "boolean" ? value.lastOk : null,
        lastError: nullableText(value.lastError, ERROR_MAX),
        lastFetched: nullableNumber(value.lastFetched),
        lastInserted: nullableNumber(value.lastInserted),
        lastFinalUrl: safeHttpUrl(value.lastFinalUrl),
        quality: normalizeSourceQuality(value.quality),
        diagnostic: ["missing_key", "rate_limited", "structure_anomaly", "circuit_open"].includes(String(value.diagnostic)) ? value.diagnostic : null,
    };
}
function normalizeFailure(value) {
    if (!isRecord(value))
        return null;
    return {
        sourceId: clampText(value.sourceId, SHORT_MAX),
        sourceName: clampText(value.sourceName, SHORT_MAX),
        error: safeDisplayText(value.error, ERROR_MAX) || "抓取失败",
    };
}
function normalizeFreshness(value) {
    if (!isRecord(value))
        return { lastRoundAgeMs: null, stale: false, severe: false };
    return {
        lastRoundAgeMs: nullableNumber(value.lastRoundAgeMs),
        stale: boolean(value.stale),
        severe: boolean(value.severe),
    };
}
/** 校验 /api/deals、/api/refresh 与 SSR 快照：坏字段降级；null 表示整份数据不可用，调用方会显示错误并保留旧内容。 */
export function normalizeBoardState(input) {
    if (!isRecord(input))
        return null;
    if (!Array.isArray(input.deals) || !Array.isArray(input.sources) || !Array.isArray(input.failures))
        return null;
    const deals = input.deals.slice(0, LIST_MAX).map(normalizeDeal).filter((deal) => deal !== null);
    // 计数以校验后真正能展示的条目为准，避免不安全链接被丢弃后状态栏还显示旧数字。
    const sourceCounts = new Map();
    for (const item of deals)
        sourceCounts.set(item.sourceId, (sourceCounts.get(item.sourceId) ?? 0) + 1);
    const sources = input.sources.slice(0, 100).map(normalizeSource).filter((source) => source !== null).map((item) => ({ ...item, activeCount: sourceCounts.get(item.id) ?? 0 }));
    const failures = input.failures.slice(0, 100).map(normalizeFailure).filter((failure) => failure !== null);
    const health = isRecord(input.sourceHealth) ? input.sourceHealth : {};
    const total = count(health.total, sources.length) || sources.length;
    const ok = Math.min(count(health.ok), total);
    const roundStatus = input.roundStatus === "success" || input.roundStatus === "partial" || input.roundStatus === "failed"
        ? input.roundStatus
        : null;
    return {
        generatedAt: finiteNumber(input.generatedAt),
        lastUpdatedAt: nullableNumber(input.lastUpdatedAt),
        lastUpdatedLabel: nullableText(input.lastUpdatedLabel, SHORT_MAX),
        nextRefreshAt: nullableNumber(input.nextRefreshAt),
        nextRefreshLabel: nullableText(input.nextRefreshLabel, SHORT_MAX),
        sourceHealth: { ok, total },
        activeCount: deals.length,
        newCount: deals.filter((deal) => deal.isNew).length,
        refreshInProgress: boolean(input.refreshInProgress),
        roundStatus,
        failures,
        sources,
        deals,
        freshness: normalizeFreshness(input.freshness),
        anomalies: [...stringList(input.anomalies, 20, 200), ...(input.deals.length > LIST_MAX ? ["看板超过安全上限，请使用分页 API"] : [])],
        pagination: isRecord(input.pagination) ? {
            offset: count(input.pagination.offset), limit: count(input.pagination.limit),
            total: count(input.pagination.total), hasMore: boolean(input.pagination.hasMore),
        } : undefined,
    };
}
