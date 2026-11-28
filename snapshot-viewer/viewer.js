import { CATEGORIES } from "../src/lib/types.js";
import { activeDeals, dayBadge, dayBucket, dayGroupTitle, formatTime, isDiscussionItem, keywordTags, loadFeedback, loadSnapshotBundle, loadViewerPersonal, matchesDayFilter, nextBoundaryDelay, rankDeals, saveFeedback, saveViewerPersonal, selectDeals, setVote, SnapshotLoadError } from "./model.js";
/** 分类色块兜底图的大图标；有真实封面图的条目不用它。 */
const CATEGORY_GLYPH = {
    "免费白嫖": "🎁",
    "限免": "⏰",
    "低价优惠": "🏷️",
    "会员订阅": "👑",
    "游戏": "🎮",
    "软件工具": "🛠️",
    "其他": "📦",
};
/** 组件只访问静态 HTML 声明的控件；DOM 引用不跨页面复用。 */
function elements(root) {
    const get = (id) => root.querySelector(`#${id}`);
    return {
        query: get("q"), source: get("source"), category: get("cat"),
        catchips: get("catchips"), timechips: get("timechips"), hotwords: get("hotwords"),
        onlyCurated: get("onlyCurated"),
        sort: get("sort"), showHidden: get("showHidden"), hiddenLabel: get("hidden-label"),
        onlyNew: get("onlyNew"), onlyFavorites: get("onlyFav"), showAll: get("showAll"), reset: get("reset"),
        retry: get("retry"), meta: get("meta"), warning: get("warning"), storageWarning: get("storage-warning"),
        failureDetails: get("failure-details"), failureSummary: get("failure-summary"), failures: get("failures"), count: get("count"), list: get("list"),
    };
}
/** 所有快照内容都通过 textContent 写入，禁止把标题或错误拼成 HTML。 */
function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined)
        element.textContent = text;
    return element;
}
/** 搜索词在标题中用 <mark> 高亮；仍只用文本节点拼接，不拼 HTML。 */
function fillTitle(link, title, query) {
    const q = query.trim().toLowerCase();
    if (!q) {
        link.textContent = title;
        return;
    }
    const lower = title.toLowerCase();
    let from = 0;
    let at = lower.indexOf(q, from);
    if (at === -1) {
        link.textContent = title;
        return;
    }
    while (at !== -1) {
        if (at > from)
            link.append(document.createTextNode(title.slice(from, at)));
        link.append(node("mark", "snapshot-mark", title.slice(at, at + q.length)));
        from = at + q.length;
        at = lower.indexOf(q, from);
    }
    if (from < title.length)
        link.append(document.createTextNode(title.slice(from)));
}
/** 七天内显示相对时间，更早的沿用快照的绝对时间标签。 */
function publishedText(publishedAt, publishedLabel, now) {
    if (publishedAt === null)
        return "发布时间未知";
    const diff = now - publishedAt;
    if (diff >= 0 && diff < 3_600_000)
        return `${Math.max(1, Math.floor(diff / 60_000))}分钟前`;
    if (diff >= 0 && diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)}小时前`;
    if (diff >= 0 && diff < 7 * 86_400_000)
        return `${Math.floor(diff / 86_400_000)}天前`;
    return publishedLabel ?? formatTime(publishedAt);
}
/** 初始化一页快照，并返回卸载时释放请求、定时器和监听器的函数。 */
export function mountSnapshotViewer(root) {
    const ui = elements(root);
    const listeners = new AbortController();
    const initial = loadViewerPersonal(() => window.localStorage);
    let personal = initial.personal;
    let storageWarning = initial.warning;
    const initialFeedback = loadFeedback(() => window.localStorage);
    let feedback = initialFeedback.feedback;
    if (initialFeedback.warning && !storageWarning)
        storageWarning = initialFeedback.warning;
    let snapshot = null;
    let previous = null;
    let status = null;
    let refreshError = null;
    let loading = false;
    let disposed = false;
    let inFlight = null;
    let requestController = null;
    let requestTimer = null;
    let boundaryTimer = null;
    let pollTimer = null;
    /** 筛选状态仅作用于当前页，来源值沿用正式看板的 sourceId。 */
    function filters() {
        const includeOther = ui.showAll.checked || ui.category.value !== "all" || ui.query.value.trim() !== "" || ui.onlyFavorites.checked;
        const sort = feedback.sort === "smart" ? undefined : feedback.sort;
        return { query: ui.query.value, sourceId: ui.source.value, category: ui.category.value, onlyNew: ui.onlyNew.checked, includeOther, sort };
    }
    /** 重新读取后保留仍有效的来源选择，分类使用项目共用枚举。 */
    function updateOptions() {
        if (!snapshot)
            return;
        const selected = ui.source.value;
        const sources = new Map(snapshot.items.map((item) => [item.sourceId, item.sourceName]));
        ui.source.replaceChildren(new Option("全部来源", "all"), ...[...sources].map(([id, name]) => new Option(name, id)));
        ui.source.value = sources.has(selected) ? selected : "all";
    }
    /** 新鲜度使用最后一份正常快照；全失败尝试只进入独立提示。 */
    function renderStatus(now) {
        ui.storageWarning.hidden = !storageWarning;
        ui.storageWarning.textContent = storageWarning;
        const latestStatus = status && (!snapshot || status.attemptedAt >= snapshot.fetchedAt) ? status : null;
        const messages = [];
        if (snapshot) {
            const failedSnapshot = snapshot.roundStatus === "failed" || snapshot.sourceHealth.ok === 0;
            ui.meta.textContent = `${failedSnapshot ? "快照记录" : "上次正常抓取"}（北京时间）${formatTime(snapshot.fetchedAt)} · 该轮来源 ${snapshot.sourceHealth.ok}/${snapshot.sourceHealth.total} 正常`;
            if (failedSnapshot)
                messages.push("该快照轮次全部来源失败，记录时间不代表成功更新。");
            if (now >= snapshot.freshUntil)
                messages.push("快照已超过新鲜期，当前内容仅供历史参考。");
        }
        else {
            ui.meta.textContent = loading ? "正在读取公开快照…" : "尚未取得可用快照。";
        }
        if (latestStatus) {
            const outcome = latestStatus.roundStatus === "failed" || latestStatus.sourceHealth.ok === 0 ? "全部来源失败" : latestStatus.roundStatus === "partial" ? "部分来源失败" : "抓取完成";
            messages.push(`最近尝试（北京时间）${formatTime(latestStatus.attemptedAt)}：${outcome}，来源 ${latestStatus.sourceHealth.ok}/${latestStatus.sourceHealth.total} 正常。${latestStatus.retainedPrevious ? "本次未发布新数据，保留上次正常快照。" : ""}`);
        }
        if (refreshError)
            messages.push(`${refreshError}${snapshot ? " 当前继续显示已加载的快照。" : " 请重新读取，或等待发布任务生成快照。"}`);
        ui.warning.hidden = messages.length === 0;
        ui.warning.textContent = messages.join(" ");
        const recentFailures = latestStatus?.failures ?? snapshot?.failures ?? [];
        ui.failureDetails.hidden = recentFailures.length === 0;
        ui.failureSummary.textContent = `来源失败详情（${recentFailures.length}）`;
        ui.failures.replaceChildren(...recentFailures.map((failure) => node("li", "", `${failure.sourceName || failure.sourceId}：${failure.error}`)));
    }
    /** 卡片头图：来源自带封面优先，加载失败或无图时用分类色块兜底，不伪造图片。 */
    function renderMedia(deal) {
        const media = node("div", "snapshot-media");
        const tile = node("div", "snapshot-tile");
        tile.append(node("span", "snapshot-tile-glyph", CATEGORY_GLYPH[deal.category] ?? "📦"));
        tile.append(node("span", "snapshot-tile-source", deal.sourceName));
        if (deal.image) {
            const img = document.createElement("img");
            img.src = deal.image;
            img.alt = "";
            img.loading = "lazy";
            img.decoding = "async";
            img.referrerPolicy = "no-referrer";
            img.addEventListener("error", () => { img.replaceWith(tile); }, { once: true });
            media.append(img);
        }
        else {
            media.append(tile);
        }
        const badges = node("div", "snapshot-media-badges");
        badges.append(node("span", "snapshot-media-badge is-cat", deal.category));
        if (deal.isNew)
            badges.append(node("span", "snapshot-media-badge is-new", "本轮新增"));
        media.append(badges);
        if (deal.expiresLabel) {
            const expiry = node("span", "snapshot-media-badge is-expiry", `${deal.expiresSoon ? "⏰ 即将截止" : "截止"} ${deal.expiresLabel}`);
            expiry.dataset.soon = String(deal.expiresSoon);
            media.append(expiry);
        }
        return media;
    }
    /** 卡片只创建经过协议与来源校验的链接，个人状态通过按钮明确表达。 */
    function renderItem(deal, now) {
        const card = node("article", "snapshot-item");
        const claimed = personal.claimed.includes(deal.canonicalUrl);
        const favorite = personal.favorites.includes(deal.canonicalUrl);
        card.dataset.claimed = String(claimed);
        card.dataset.category = deal.category;
        const bucket = dayBucket(deal.publishedAt ?? deal.firstSeenAt ?? null, now);
        card.dataset.bucket = bucket;
        card.append(renderMedia(deal));
        const body = node("div", "snapshot-item-body");
        const title = node("h2", "");
        const link = node("a", "");
        link.href = deal.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        fillTitle(link, deal.title, ui.query.value);
        title.append(link);
        const meta = node("p", "snapshot-item-meta");
        meta.append(document.createTextNode(`${deal.sourceName} · `));
        const day = node("span", "snapshot-day", dayBadge(deal.publishedAt ?? deal.firstSeenAt ?? null, now));
        day.dataset.bucket = bucket;
        meta.append(day);
        const relative = publishedText(deal.publishedAt, deal.publishedLabel, now);
        if (deal.publishedAt !== null && bucket !== "unknown")
            meta.append(document.createTextNode(` · ${relative}`));
        body.append(title, meta);
        if (deal.summary)
            body.append(node("p", "snapshot-summary", deal.summary));
        const tags = node("div", "snapshot-tags");
        const addTag = (text, kind) => {
            const tag = node("span", "snapshot-tag", text);
            tag.dataset.kind = kind;
            tags.append(tag);
        };
        if (claimed)
            addTag("已领", "claimed");
        for (const keyword of keywordTags(deal.title)) {
            const tag = node("button", "snapshot-tag", keyword);
            tag.type = "button";
            tag.dataset.kind = "kw";
            tag.dataset.kw = keyword;
            tag.title = `按「${keyword}」筛选`;
            tags.append(tag);
        }
        if (tags.childElementCount)
            body.append(tags);
        const actions = node("div", "snapshot-item-actions");
        const liked = feedback.liked.includes(deal.canonicalUrl);
        const hiddenItem = feedback.hidden.includes(deal.canonicalUrl);
        for (const [action, selected, label, aria] of [
            ["like", liked, "👍", liked ? "已标记喜欢，再点取消" : "喜欢这类内容，之后优先推荐"],
            ["dislike", hiddenItem, "👎", hiddenItem ? "已隐藏，再点恢复显示" : "不喜欢，隐藏这条并让同类内容靠后"],
        ]) {
            const button = node("button", "snapshot-button snapshot-vote", label);
            button.type = "button";
            button.dataset.action = action;
            button.dataset.url = deal.canonicalUrl;
            button.setAttribute("aria-pressed", String(selected));
            button.setAttribute("aria-label", `${aria}：${deal.title}`);
            actions.append(button);
        }
        for (const [action, selected, label] of [["favorite", favorite, favorite ? "已收藏" : "收藏"], ["claim", claimed, claimed ? "已领 · 撤销" : "标记已领"]]) {
            const button = node("button", "snapshot-button", label);
            button.type = "button";
            button.dataset.action = action;
            button.dataset.url = deal.canonicalUrl;
            button.setAttribute("aria-pressed", String(selected));
            button.setAttribute("aria-label", `${label}：${deal.title}`);
            actions.append(button);
        }
        body.append(actions);
        card.append(body);
        return card;
    }
    /** 分类 chips 与下拉保持同一状态：计数来自当前留存条目，点击即切换分类筛选。 */
    function renderCategoryChips(active) {
        const counts = new Map();
        for (const item of active)
            counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
        const make = (value, text, count) => {
            const chip = node("button", "snapshot-chip", text);
            chip.type = "button";
            chip.dataset.catchip = value;
            chip.dataset.active = String(ui.category.value === value);
            chip.append(node("span", "snapshot-chip-count", String(count)));
            return chip;
        };
        const chips = [make("all", "全部", active.length)];
        for (const category of CATEGORIES) {
            const count = counts.get(category) ?? 0;
            if (count > 0)
                chips.push(make(category, category, count));
        }
        ui.catchips.replaceChildren(...chips);
    }
    /** 时间 chips：今天 / 昨天 / 更早的条数来自当前留存条目，点击即按天筛选。 */
    function renderTimeChips(active, now) {
        const counts = { all: active.length, today: 0, yesterday: 0, earlier: 0 };
        for (const item of active) {
            const bucket = dayBucket(item.publishedAt ?? item.firstSeenAt ?? null, now);
            if (bucket === "today")
                counts.today += 1;
            else if (bucket === "yesterday")
                counts.yesterday += 1;
            else
                counts.earlier += 1;
        }
        const defs = [["all", "全部时间"], ["today", "今天"], ["yesterday", "昨天"], ["earlier", "更早"]];
        ui.timechips.replaceChildren(...defs.map(([value, label]) => {
            const chip = node("button", "snapshot-chip", label);
            chip.type = "button";
            chip.dataset.daychip = value;
            chip.dataset.active = String(feedback.day === value);
            chip.append(node("span", "snapshot-chip-count", String(counts[value])));
            return chip;
        }));
    }
    /** 最新发布模式下的按天分组标题，吸顶显示当天条数。 */
    function renderDayHeader(bucket, sampleAt, count) {
        const header = node("div", "snapshot-day-header");
        header.append(node("span", "snapshot-day-header-title", dayGroupTitle(bucket, sampleAt)));
        header.append(node("span", "snapshot-day-header-count", `${count} 条`));
        return header;
    }
    /** 热门关键词按当前留存标题的出现次数排序，点击即按该词搜索（搜索自动包含「其他」）。 */
    function renderHotwords(active) {
        const counts = new Map();
        for (const item of active)
            for (const label of keywordTags(item.title))
                counts.set(label, (counts.get(label) ?? 0) + 1);
        const top = [...counts.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10);
        ui.hotwords.hidden = top.length === 0;
        if (!top.length) {
            ui.hotwords.replaceChildren();
            return;
        }
        const chips = top.map(([label, count]) => {
            const chip = node("button", "snapshot-chip", label);
            chip.type = "button";
            chip.dataset.kw = label;
            chip.dataset.active = String(ui.query.value.trim() === label);
            chip.append(node("span", "snapshot-chip-count", String(count)));
            return chip;
        });
        ui.hotwords.replaceChildren(node("span", "snapshot-hotwords-label", "热门关键词"), ...chips);
    }
    /** 加载、空结果和错误共用可重试入口，错误轮询不会清空已经加载的列表。 */
    function emptyState(title, description) {
        const state = node("div", "snapshot-empty");
        state.append(node("h2", "", title), node("p", "", description));
        const retry = node("button", "snapshot-button", loading ? "正在读取…" : "重新读取快照");
        retry.type = "button";
        retry.dataset.action = "retry";
        retry.disabled = loading;
        state.append(retry);
        return state;
    }
    /** 每次绘制重算留存和到期；保留被操作按钮的键盘焦点。 */
    function render() {
        if (disposed)
            return;
        const now = Date.now();
        renderStatus(now);
        ui.retry.disabled = loading;
        ui.retry.textContent = loading ? "正在读取…" : "重新读取快照";
        ui.list.setAttribute("aria-busy", String(loading));
        const focused = document.activeElement instanceof HTMLButtonElement && ui.list.contains(document.activeElement) ? document.activeElement : null;
        const focusAction = focused?.dataset.action;
        const focusUrl = focused?.dataset.url;
        if (!snapshot) {
            ui.count.textContent = loading ? "正在加载…" : "尚无可展示条目";
            ui.hotwords.hidden = true;
            ui.catchips.replaceChildren();
            ui.timechips.replaceChildren();
            ui.list.replaceChildren(emptyState(loading ? "正在加载线索…" : "快照暂时不可用", "读取公开快照后即可搜索、收藏和标记已领。"));
        }
        else {
            const active = activeDeals(snapshot, previous, now, status);
            const selected = selectDeals(snapshot, previous, filters(), personal, now, ui.onlyFavorites.checked, status);
            const hiddenCount = selected.filter((item) => feedback.hidden.includes(item.canonicalUrl)).length;
            const visible = ui.showHidden.checked ? selected : selected.filter((item) => !feedback.hidden.includes(item.canonicalUrl));
            // 精选模式：隐藏讨论/求购/闲聊类低价值条目；已收藏或已点赞的始终保留。
            const curatedOut = feedback.curated
                ? visible.filter((item) => isDiscussionItem(item) && !personal.favorites.includes(item.canonicalUrl) && !feedback.liked.includes(item.canonicalUrl))
                : [];
            const curatedKept = curatedOut.length ? visible.filter((item) => !curatedOut.includes(item)) : visible;
            const stamp = (item) => item.publishedAt ?? item.firstSeenAt ?? null;
            const dayKept = curatedKept.filter((item) => matchesDayFilter(dayBucket(stamp(item), now), feedback.day));
            const shown = feedback.sort === "smart" ? rankDeals(dayKept, feedback, personal, now) : dayKept;
            renderCategoryChips(active);
            renderTimeChips(active, now);
            renderHotwords(active);
            ui.hiddenLabel.textContent = feedback.hidden.length ? `显示已隐藏（${feedback.hidden.length}）` : "显示已隐藏";
            ui.count.textContent = `显示 ${shown.length} / ${active.length} 条 · 本轮新增 ${active.filter((item) => item.isNew).length} 条${curatedOut.length ? ` · 精选已过滤 ${curatedOut.length} 条低价值` : ""}${hiddenCount && !ui.showHidden.checked ? ` · 已隐藏 ${hiddenCount} 条` : ""}`;
            if (!shown.length) {
                ui.list.replaceChildren(emptyState("没有符合条件的线索", "可以调整左侧筛选，或稍后重新读取快照。过期与超过七天的条目会自动移除。"));
            }
            else if (feedback.sort === "newest" && feedback.day === "all") {
                // 最新发布模式按天分组：今天 / 昨天 / 前天 / 更早，一眼分清新旧。
                const children = [];
                const counts = new Map();
                for (const item of shown) {
                    const bucket = dayBucket(stamp(item), now);
                    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
                }
                let lastBucket = null;
                for (const item of shown) {
                    const bucket = dayBucket(stamp(item), now);
                    if (bucket !== lastBucket) {
                        lastBucket = bucket;
                        children.push(renderDayHeader(bucket, stamp(item), counts.get(bucket) ?? 0));
                    }
                    children.push(renderItem(item, now));
                }
                ui.list.replaceChildren(...children);
            }
            else {
                ui.list.replaceChildren(...shown.map((deal) => renderItem(deal, now)));
            }
        }
        if (focusAction && focusUrl) {
            [...ui.list.querySelectorAll("button[data-action]")].find((button) => button.dataset.action === focusAction && button.dataset.url === focusUrl)?.focus({ preventScroll: true });
        }
        if (boundaryTimer !== null)
            clearTimeout(boundaryTimer);
        boundaryTimer = null;
        if (document.visibilityState === "visible")
            boundaryTimer = setTimeout(render, nextBoundaryDelay(snapshot, now));
    }
    /** 多个刷新入口共用同一个请求；失败时继续展示旧数据并留下可重试提示。 */
    function refresh() {
        if (disposed)
            return Promise.resolve();
        if (inFlight)
            return inFlight;
        const controller = new AbortController();
        requestController = controller;
        requestTimer = setTimeout(() => controller.abort(), 15_000);
        loading = true;
        render();
        inFlight = loadSnapshotBundle(window.fetch.bind(window), controller.signal).then((bundle) => {
            if (disposed)
                return;
            snapshot = bundle.latest;
            previous = bundle.previous;
            status = bundle.status ?? (status && status.attemptedAt >= bundle.latest.fetchedAt ? status : null);
            refreshError = null;
            updateOptions();
        }).catch((error) => {
            if (disposed)
                return;
            if (error instanceof SnapshotLoadError && error.status)
                status = error.status;
            refreshError = `读取快照失败：${error instanceof Error ? error.message : "网络或数据异常"}`;
        }).finally(() => {
            if (requestTimer !== null)
                clearTimeout(requestTimer);
            requestTimer = null;
            inFlight = null;
            requestController = null;
            loading = false;
            render();
        });
        return inFlight;
    }
    /** 页面恢复可见或重新聚焦时先更新到期状态，再获取最新数据。 */
    function resume() {
        if (disposed || document.visibilityState !== "visible")
            return;
        render();
        void refresh();
    }
    /** 卸载和进入往返缓存时停止后台工作，避免旧响应写入已卸载页面。 */
    function dispose() {
        if (disposed)
            return;
        disposed = true;
        listeners.abort();
        requestController?.abort();
        if (requestTimer !== null)
            clearTimeout(requestTimer);
        if (boundaryTimer !== null)
            clearTimeout(boundaryTimer);
        if (pollTimer !== null)
            clearInterval(pollTimer);
    }
    ui.category.replaceChildren(new Option("全部分类", "all"), ...CATEGORIES.map((category) => new Option(category, category)));
    ui.sort.value = feedback.sort;
    ui.onlyCurated.checked = feedback.curated;
    ui.onlyCurated.addEventListener("input", () => {
        feedback = { ...feedback, curated: ui.onlyCurated.checked };
        if (!saveFeedback(() => window.localStorage, feedback))
            storageWarning = "未保存：浏览器存储写入失败。精选偏好刷新后可能丢失。";
        render();
    }, { signal: listeners.signal });
    ui.timechips.addEventListener("click", (event) => {
        const chip = event.target instanceof Element ? event.target.closest("button[data-daychip]") : null;
        if (!chip || !ui.timechips.contains(chip))
            return;
        feedback = { ...feedback, day: (chip.dataset.daychip ?? "all") };
        if (!saveFeedback(() => window.localStorage, feedback))
            storageWarning = "未保存：浏览器存储写入失败。时间筛选刷新后可能丢失。";
        render();
    }, { signal: listeners.signal });
    for (const control of [ui.query, ui.source, ui.category, ui.onlyNew, ui.onlyFavorites, ui.showAll, ui.showHidden])
        control.addEventListener("input", render, { signal: listeners.signal });
    ui.sort.addEventListener("input", () => {
        feedback = { ...feedback, sort: ui.sort.value };
        if (!saveFeedback(() => window.localStorage, feedback))
            storageWarning = "未保存：浏览器存储写入失败。排序偏好刷新后可能丢失。";
        render();
    }, { signal: listeners.signal });
    ui.reset.addEventListener("click", () => {
        ui.query.value = "";
        ui.source.value = "all";
        ui.category.value = "all";
        ui.onlyNew.checked = false;
        ui.onlyFavorites.checked = false;
        ui.showAll.checked = false;
        ui.showHidden.checked = false;
        ui.onlyCurated.checked = true;
        feedback = { ...feedback, curated: true, day: "all" };
        saveFeedback(() => window.localStorage, feedback);
        render();
    }, { signal: listeners.signal });
    ui.retry.addEventListener("click", () => { void refresh(); }, { signal: listeners.signal });
    const applyKeyword = (keyword) => {
        ui.query.value = keyword;
        render();
    };
    ui.catchips.addEventListener("click", (event) => {
        const chip = event.target instanceof Element ? event.target.closest("button[data-catchip]") : null;
        if (!chip || !ui.catchips.contains(chip))
            return;
        ui.category.value = chip.dataset.catchip ?? "all";
        render();
    }, { signal: listeners.signal });
    ui.hotwords.addEventListener("click", (event) => {
        const chip = event.target instanceof Element ? event.target.closest("button[data-kw]") : null;
        if (chip?.dataset.kw)
            applyKeyword(chip.dataset.kw);
    }, { signal: listeners.signal });
    ui.list.addEventListener("click", (event) => {
        const keywordTag = event.target instanceof Element ? event.target.closest("button[data-kw]") : null;
        if (keywordTag?.dataset.kw && ui.list.contains(keywordTag)) {
            applyKeyword(keywordTag.dataset.kw);
            return;
        }
        const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
        if (!button || !ui.list.contains(button))
            return;
        if (button.dataset.action === "retry") {
            void refresh();
            return;
        }
        const url = button.dataset.url;
        if (!url || !snapshot?.items.some((item) => item.canonicalUrl === url))
            return;
        if (button.dataset.action === "like" || button.dataset.action === "dislike") {
            const item = snapshot.items.find((entry) => entry.canonicalUrl === url);
            if (!item)
                return;
            const vote = button.dataset.action === "like"
                ? (feedback.liked.includes(url) ? null : "like")
                : (feedback.hidden.includes(url) ? null : "dislike");
            feedback = setVote(feedback, item, vote);
            if (!saveFeedback(() => window.localStorage, feedback))
                storageWarning = "未保存：浏览器存储写入失败。当前点赞与点踩仅在本页有效，刷新后可能丢失。";
            render();
            return;
        }
        const field = button.dataset.action === "favorite" ? "favorites" : "claimed";
        const values = personal[field];
        personal = { ...personal, [field]: values.includes(url) ? values.filter((value) => value !== url) : [...values, url] };
        storageWarning = saveViewerPersonal(() => window.localStorage, personal) ? null : "未保存：浏览器存储写入失败。当前收藏与已领仅在本页有效，刷新后可能丢失。";
        render();
    }, { signal: listeners.signal });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible")
            resume();
        else if (boundaryTimer !== null) {
            clearTimeout(boundaryTimer);
            boundaryTimer = null;
        }
    }, { signal: listeners.signal });
    window.addEventListener("focus", resume, { signal: listeners.signal });
    window.addEventListener("pagehide", dispose, { signal: listeners.signal });
    pollTimer = setInterval(() => { if (document.visibilityState === "visible") {
        render();
        void refresh();
    } }, 30_000);
    void refresh();
    return dispose;
}
let unmount = null;
/** 往返缓存恢复后重新挂载，避免已释放的页面停留在旧快照。 */
function boot() {
    const root = document.getElementById("snapshot-app");
    if (root && !unmount)
        unmount = mountSnapshotViewer(root);
}
window.addEventListener("pageshow", boot);
window.addEventListener("pagehide", () => { unmount?.(); unmount = null; });
boot();
