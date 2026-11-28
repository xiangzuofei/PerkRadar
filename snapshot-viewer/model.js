import { safeDisplayText, safeHttpUrl } from "../src/lib/board-view.js";
import { classifySignals } from "../src/lib/classify.js";
import { BOARD_MAX_ITEMS, RETENTION_MS, SUMMARY_MAX, TITLE_MAX } from "../src/lib/config.js";
import { filterDeals } from "../src/lib/filter-deals.js";
import { loadPersonal, STORAGE_KEY } from "../src/lib/personal-storage.js";
import { isExpiringSoon, isStale, referenceTime } from "../src/lib/retention.js";
import { SOURCE_DEFS } from "../src/lib/source-defs.js";
import { CATEGORIES } from "../src/lib/types.js";
import { canonicalUrl } from "../src/lib/url.js";
const POLL_MS = 30_000;
/** 快照是外部输入，只接受普通对象，避免异常 JSON 影响渲染。 */
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** 公开快照时间必须为可解析字符串；空值保持未知。 */
function timestamp(value) {
    if (typeof value !== "string" || !value.trim())
        return null;
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
}
/** 轮次字段保持和正式看板相同的枚举边界。 */
function roundStatus(value) {
    return value === "success" || value === "partial" || value === "failed" ? value : null;
}
/** 来源成败只展示实际合法计数，拒绝矛盾的总数。 */
function health(value) {
    if (!record(value))
        return null;
    const { ok, total } = value;
    if (typeof ok !== "number" || typeof total !== "number" || !Number.isSafeInteger(ok) || !Number.isSafeInteger(total) || ok < 0 || total < ok)
        return null;
    return { ok, total };
}
/** 错误文案只作为文本展示，长度沿用看板的显示边界。 */
function failures(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter(record).slice(0, 100).map((entry) => ({
        sourceId: safeDisplayText(entry.sourceId, 80),
        sourceName: safeDisplayText(entry.sourceName, 80),
        error: safeDisplayText(entry.error, 160) || "抓取失败",
    }));
}
/** 原文链接同时受协议和既有来源域名限制，复用正式看板的 URL 清洗。 */
function sourceItem(value, index, fetchedAt) {
    if (!record(value))
        return null;
    const safeUrl = safeHttpUrl(value.url);
    const url = safeUrl ? canonicalUrl(safeUrl) : null;
    const source = SOURCE_DEFS.find((entry) => entry.id === value.sourceId);
    if (!url || !source)
        return null;
    const host = new URL(url).hostname.toLowerCase();
    if (!source.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)))
        return null;
    const title = safeDisplayText(value.title, TITLE_MAX);
    if (!title)
        return null;
    for (const key of ["publishedAt", "expiresAt", "firstSeenAt"]) {
        if (value[key] !== undefined && value[key] !== null && timestamp(value[key]) === null)
            return null;
    }
    const category = CATEGORIES.includes(value.category) ? value.category : "其他";
    const rawImage = safeHttpUrl(value.image);
    return {
        id: index,
        url,
        canonicalUrl: url,
        title,
        summary: safeDisplayText(value.summary, SUMMARY_MAX),
        image: rawImage ? rawImage.replace(/^http:/, "https:") : null,
        category,
        sourceId: source.id,
        sourceName: source.name,
        publishedAt: timestamp(value.publishedAt),
        firstSeenAt: timestamp(value.firstSeenAt) ?? timestamp(value.publishedAt) ?? fetchedAt,
        expiresAt: timestamp(value.expiresAt),
        publishedLabel: null,
        expiresLabel: null,
        expiresSoon: false,
        isNew: value.isNew === true,
    };
}
/** 拒绝缺时间、错误结构和不安全条目；无效旧文件不能充当新增基线。 */
export function parseSnapshot(value) {
    if (!record(value) || value.schema !== "daily-deals.snapshot.v1" || !Array.isArray(value.items) || value.items.length > BOARD_MAX_ITEMS)
        return null;
    const fetchedAt = timestamp(value.fetchedAt);
    const freshUntil = timestamp(value.freshUntil);
    const sourceHealth = health(value.sourceHealth);
    if (fetchedAt === null || freshUntil === null || !sourceHealth || (value.baselineAvailable !== undefined && typeof value.baselineAvailable !== "boolean"))
        return null;
    const items = [];
    const urls = new Set();
    for (const [index, raw] of value.items.entries()) {
        const item = sourceItem(raw, index, fetchedAt);
        if (!item)
            return null;
        if (urls.has(item.canonicalUrl))
            continue;
        urls.add(item.canonicalUrl);
        items.push(item);
    }
    return { fetchedAt, freshUntil, sourceHealth, items, roundStatus: roundStatus(value.roundStatus), failures: failures(value.failures), baselineAvailable: value.baselineAvailable };
}
/** status 独立记录最近一次尝试，不覆盖上一次正常快照的时间。 */
export function parseSnapshotStatus(value) {
    if (!record(value))
        return null;
    const attemptedAt = timestamp(value.attemptedAt);
    const sourceHealth = health(value.sourceHealth);
    if (attemptedAt === null || !sourceHealth || typeof value.retainedPrevious !== "boolean")
        return null;
    return { attemptedAt, sourceHealth, roundStatus: roundStatus(value.roundStatus), failures: failures(value.failures), retainedPrevious: value.retainedPrevious };
}
/** 新版使用发布时的新增结果；旧版仅在取得有效前一轮时做 URL 差集。 */
export function activeDeals(snapshot, previous, now, status = null) {
    const baseline = previous && previous.fetchedAt < snapshot.fetchedAt ? previous : null;
    const previousUrls = new Set(baseline?.items.map((item) => item.canonicalUrl) ?? []);
    const retained = snapshot.roundStatus === "failed" || snapshot.sourceHealth.ok === 0 || (status !== null && status.attemptedAt >= snapshot.fetchedAt && status.retainedPrevious);
    return snapshot.items.filter((item) => !isStale(item, now)).map((item) => ({
        ...item,
        isNew: !retained && (snapshot.baselineAvailable === undefined ? baseline !== null && !previousUrls.has(item.canonicalUrl) : snapshot.baselineAvailable && item.isNew),
        expiresSoon: isExpiringSoon(item.expiresAt, now),
        publishedLabel: item.publishedAt === null ? null : formatTime(item.publishedAt),
        expiresLabel: item.expiresAt === null ? null : formatTime(item.expiresAt),
    }));
}
/** 标题、分类、来源、收藏和已领顺序与正式看板使用同一个过滤器。 */
export function selectDeals(snapshot, previous, filters, personal, now, onlyFavorites = false, status = null) {
    const shown = filterDeals(activeDeals(snapshot, previous, now, status), filters, personal);
    return onlyFavorites ? shown.filter((item) => personal.favorites.includes(item.canonicalUrl)) : shown;
}
/** 没有可展示的 latest 时仍向页面传递本次真实失败状态。 */
export class SnapshotLoadError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "SnapshotLoadError";
    }
}
/** 三个文件立即并行读取，旧基线和状态缺失可降级，latest 失败则保留给调用方重试。 */
export async function loadSnapshotBundle(fetcher, signal) {
    const load = async (name) => {
        const response = await fetcher(name, { cache: "no-store", signal });
        if (!response.ok)
            throw new Error(`${name} HTTP ${response.status}`);
        return response.json();
    };
    const [latestResult, previousResult, statusResult] = await Promise.allSettled([load("latest.json"), load("previous.json"), load("status.json")]);
    const status = statusResult.status === "fulfilled" ? parseSnapshotStatus(statusResult.value) : null;
    if (latestResult.status === "rejected")
        throw new SnapshotLoadError(latestResult.reason instanceof Error ? latestResult.reason.message : "latest.json 读取失败", status);
    const latest = parseSnapshot(latestResult.value);
    if (!latest)
        throw new SnapshotLoadError("latest.json 不是有效的公开快照", status);
    return {
        latest,
        previous: previousResult.status === "fulfilled" ? parseSnapshot(previousResult.value) : null,
        status,
    };
}
/** localStorage 的 getter 自身也可能抛错，加载失败仍保留可操作的页内状态。 */
export function loadViewerPersonal(getStorage) {
    const empty = { claimed: [], favorites: [] };
    const warning = "浏览器存储不可用或已保存内容无法读取；收藏与已领仍可在本页操作，可能无法保存。";
    try {
        const storage = getStorage();
        let readFailed = false;
        const personal = loadPersonal({
            getItem: (key) => {
                let raw;
                try {
                    raw = storage.getItem(key);
                }
                catch (error) {
                    readFailed = true;
                    throw error;
                }
                if (raw !== null) {
                    try {
                        const value = JSON.parse(raw);
                        if (!record(value) || !Array.isArray(value.claimed) || !Array.isArray(value.favorites))
                            readFailed = true;
                    }
                    catch {
                        readFailed = true;
                    }
                }
                return raw;
            },
            setItem: (key, value) => {
                try {
                    storage.setItem(key, value);
                }
                catch (error) {
                    readFailed = true;
                    throw error;
                }
            },
        });
        return { personal, warning: readFailed ? warning : null };
    }
    catch {
        return { personal: empty, warning };
    }
}
/** 保存失败不回滚当前页面的选择，调用方应持续显示明确的未保存提示。 */
export function saveViewerPersonal(getStorage, personal) {
    try {
        getStorage().setItem(STORAGE_KEY, JSON.stringify(personal));
        return true;
    }
    catch {
        return false;
    }
}
/** 标题里可直接成标签的关键词；顺序即展示优先级，每条最多取三个。 */
export const KEYWORD_TAGS = [
    [/限免/, "限免"],
    [/永免/, "永免"],
    [/白嫖/, "白嫖"],
    [/免费/, "免费"],
    [/[0零]\s*(?:元|刀)|\d\s*分钱/, "0元"],
    [/半价/, "半价"],
    [/秒杀/, "秒杀"],
    [/红包/, "红包"],
    [/抽奖/, "抽奖"],
    [/国补|国家补贴/, "国补"],
    [/史低/, "史低"],
    [/兑换码/, "兑换码"],
    [/优惠码|折扣码/, "优惠码"],
    [/返现|返利/, "返利"],
    [/赠送|就送|免费送/, "赠送"],
    [/steam/i, "Steam"],
    [/epic/i, "Epic"],
    [/终身/, "终身"],
    [/拼车/, "拼车"],
    [/机场/, "机场"],
    [/会员/, "会员"],
    [/VPS|云服务器|服务器/, "服务器"],
];
export function keywordTags(title) {
    const out = [];
    for (const [pattern, label] of KEYWORD_TAGS) {
        if (pattern.test(title) && !out.includes(label))
            out.push(label);
        if (out.length >= 3)
            break;
    }
    return out;
}
/** 点赞/点踩反馈独立存放，不触碰收藏与已领的既有存储键和形状。 */
export const FEEDBACK_KEY = "perkradar-feedback-v1";
export function emptyFeedback() {
    return { liked: [], hidden: [], likeSignals: {}, dislikeSignals: {}, sort: "smart", curated: true, day: "all" };
}
/** 一条内容的可学习信号：分类、来源与标题关键词。 */
export function itemSignals(item) {
    return [`cat:${item.category}`, `src:${item.sourceId}`, ...keywordTags(item.title).map((tag) => `kw:${tag}`)];
}
function bump(signals, keys, delta) {
    const next = { ...signals };
    for (const key of keys) {
        const value = (next[key] ?? 0) + delta;
        if (value > 0)
            next[key] = value;
        else
            delete next[key];
    }
    return next;
}
/** 设置某条内容的投票：先撤销旧票的信号再记新票，vote 为 null 表示取消投票。 */
export function setVote(feedback, item, vote) {
    const url = item.canonicalUrl;
    const keys = itemSignals(item);
    let liked = feedback.liked;
    let hidden = feedback.hidden;
    let likeSignals = feedback.likeSignals;
    let dislikeSignals = feedback.dislikeSignals;
    if (liked.includes(url)) {
        liked = liked.filter((value) => value !== url);
        likeSignals = bump(likeSignals, keys, -1);
    }
    if (hidden.includes(url)) {
        hidden = hidden.filter((value) => value !== url);
        dislikeSignals = bump(dislikeSignals, keys, -1);
    }
    if (vote === "like") {
        liked = [...liked, url];
        likeSignals = bump(likeSignals, keys, 1);
    }
    if (vote === "dislike") {
        hidden = [...hidden, url];
        dislikeSignals = bump(dislikeSignals, keys, 1);
    }
    return { ...feedback, liked, hidden, likeSignals, dislikeSignals };
}
function stringList(value, cap) {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value.filter((entry) => typeof entry === "string" && entry.length > 0))].slice(0, cap);
}
function signalMap(value) {
    if (!record(value))
        return {};
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 300)) {
        if (typeof entry === "number" && Number.isFinite(entry) && entry > 0)
            out[key.slice(0, 80)] = Math.min(99, Math.floor(entry));
    }
    return out;
}
/** 反馈读取失败时回落到空反馈并给出提示，不影响浏览与收藏。 */
export function loadFeedback(getStorage) {
    const warning = "浏览器存储不可用或反馈内容无法读取；点赞与点踩仍可在本页操作，可能无法保存。";
    try {
        const raw = getStorage().getItem(FEEDBACK_KEY);
        if (raw === null)
            return { feedback: emptyFeedback(), warning: null };
        const value = JSON.parse(raw);
        if (!record(value))
            return { feedback: emptyFeedback(), warning };
        return {
            feedback: {
                liked: stringList(value.liked, 500),
                hidden: stringList(value.hidden, 500),
                likeSignals: signalMap(value.likeSignals),
                dislikeSignals: signalMap(value.dislikeSignals),
                sort: value.sort === "newest" || value.sort === "expiring" ? value.sort : "smart",
                curated: value.curated !== false,
                day: value.day === "today" || value.day === "yesterday" || value.day === "earlier" ? value.day : "all",
            },
            warning: null,
        };
    }
    catch {
        return { feedback: emptyFeedback(), warning };
    }
}
export function saveFeedback(getStorage, feedback) {
    try {
        getStorage().setItem(FEEDBACK_KEY, JSON.stringify(feedback));
        return true;
    }
    catch {
        return false;
    }
}
const CATEGORY_BASE = { "限免": 50, "免费白嫖": 48, "低价优惠": 42, "会员订阅": 38, "游戏": 34, "软件工具": 26, "其他": 10 };
/** 智能排序分数：分类重要性打底，临近截止最紧要，再叠加新鲜度与点赞/点踩学到的偏好。 */
export function scoreItem(item, feedback, personal, now) {
    let score = CATEGORY_BASE[item.category] ?? 10;
    if (item.expiresSoon)
        score += 30;
    else if (item.expiresAt !== null && item.expiresAt > now && item.expiresAt - now <= 86_400_000)
        score += 18;
    if (item.isNew)
        score += 12;
    if (item.publishedAt !== null) {
        const age = now - item.publishedAt;
        if (age >= 0 && age <= 6 * 3_600_000)
            score += 8;
        else if (age >= 0 && age <= 86_400_000)
            score += 4;
    }
    if (personal.favorites.includes(item.canonicalUrl))
        score += 15;
    let bonus = 0;
    let penalty = 0;
    for (const key of itemSignals(item)) {
        bonus += (feedback.likeSignals[key] ?? 0) * 6;
        penalty += (feedback.dislikeSignals[key] ?? 0) * 8;
    }
    score += Math.min(36, bonus) - Math.min(48, penalty);
    if (personal.claimed.includes(item.canonicalUrl))
        score -= 1000;
    return score;
}
/** 按智能分数降序，同分按发布时间降序；不改动入参数组。 */
export function rankDeals(items, feedback, personal, now) {
    return items
        .map((item, index) => ({ item, index, score: scoreItem(item, feedback, personal, now) }))
        .sort((a, b) => b.score - a.score || (b.item.publishedAt ?? 0) - (a.item.publishedAt ?? 0) || a.index - b.index)
        .map((entry) => entry.item);
}
/** 到期、七天留存和新鲜度边界按实际时刻刷新；最长三十秒再复核一次。 */
export function nextBoundaryDelay(snapshot, now) {
    let delay = POLL_MS;
    const consider = (at) => {
        if (at > now)
            delay = Math.min(delay, at - now);
    };
    if (snapshot) {
        consider(snapshot.freshUntil);
        for (const item of snapshot.items) {
            if (item.expiresAt !== null)
                consider(item.expiresAt);
            consider(referenceTime(item) + RETENTION_MS + 1);
        }
    }
    return Math.max(1, Math.min(POLL_MS, delay));
}
const beijing = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
/** 统一按北京时间显示真实抓取和活动时间，不信任快照里的展示字符串。 */
export function formatTime(at) {
    return beijing.format(at);
}
const beijingDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const beijingClock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
const beijingDate = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short" });
/** 北京时间下的日历日序号（UTC 天数），用于跨日比较，避免本地时区干扰。 */
function beijingDayIndex(at) {
    const [year, month, day] = beijingDay.format(at).split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}
/** 按北京时间日历日把发布时间分桶：今天 / 昨天 / 前天 / 更早。未来时间按今天处理。 */
export function dayBucket(at, now) {
    if (at === null || !Number.isFinite(at))
        return "unknown";
    const diff = beijingDayIndex(now) - beijingDayIndex(at);
    if (diff <= 0)
        return "today";
    if (diff === 1)
        return "yesterday";
    if (diff === 2)
        return "dayBefore";
    return "earlier";
}
export const DAY_BUCKET_LABEL = {
    today: "今天",
    yesterday: "昨天",
    dayBefore: "前天",
    earlier: "更早",
    unknown: "时间未知",
};
/** 卡片上的时间徽标文案：如「今天 14:32」「昨天 09:05」「前天」「11月25日」。 */
export function dayBadge(at, now) {
    if (at === null)
        return "时间未知";
    const bucket = dayBucket(at, now);
    if (bucket === "today")
        return `今天 ${beijingClock.format(at)}`;
    if (bucket === "yesterday")
        return `昨天 ${beijingClock.format(at)}`;
    if (bucket === "dayBefore")
        return `前天 ${beijingClock.format(at)}`;
    return beijingDate.format(at);
}
/** 分组标题文案：如「今天 · 11月28日 周六」。 */
export function dayGroupTitle(bucket, sampleAt) {
    if (bucket === "unknown" || sampleAt === null)
        return "时间未知";
    return `${DAY_BUCKET_LABEL[bucket]} · ${beijingDate.format(sampleAt)}`;
}
/** 时间筛选与分桶的对应关系：earlier 包含前天与更早。 */
export function matchesDayFilter(bucket, day) {
    if (day === "all")
        return true;
    if (day === "today")
        return bucket === "today";
    if (day === "yesterday")
        return bucket === "yesterday";
    return bucket === "dayBefore" || bucket === "earlier" || bucket === "unknown";
}
/** 低价值判定与正式看板共用同一套分类信号：被判为讨论/求购/闲聊的不是优惠线索。 */
export function isDiscussionItem(item) {
    return classifySignals(item.title, item.sourceId).contentType === "discussion";
}
