/**
 * 从订阅源条目里提取来源自带的第一张配图（封面图）。
 * 只接受来源内容里真实存在的图片地址，不拼接、不猜测；拿不到就返回 null，
 * 界面会用分类色块兜底。论坛类来源（NodeSeek / V2EX / LINUX DO）通常没有配图。
 */

const MAX_IMAGE_CHARS = 2048;

/** 明显不是内容配图的地址：表情、头像、占位与追踪像素、矢量图标。 */
const JUNK_PATTERN = /\/emoji\/|emoji|avatar|spacer|blank\.|pixel|1x1|transparent\.|\.svg(\?|$)/i;

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** 校验并规整图片地址：仅 https（http 升级），拒绝凭据、超长和明显的非内容图片。 */
export function cleanImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = decodeEntities(value.trim());
  if (!raw || raw.length > MAX_IMAGE_CHARS || /[\u0000-\u001f\u007f\s]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (JUNK_PATTERN.test(url.pathname)) return null;
  if (url.href.length > MAX_IMAGE_CHARS) return null;
  return url.href;
}

function attr(node: unknown, name: string): string | null {
  if (!node || typeof node !== "object") return null;
  const value = (node as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value : null;
}

/** media:content / media:thumbnail / enclosure 这类结构化图片节点。 */
function structuredImage(record: Record<string, unknown>): string | null {
  const nodes: unknown[] = [];
  for (const key of ["thumbnail", "content", "enclosure", "group"]) {
    const value = record[key];
    if (Array.isArray(value)) nodes.push(...value);
    else if (value !== undefined) nodes.push(value);
  }
  for (const node of nodes) {
    const url = attr(node, "@_url");
    if (!url) continue;
    const type = attr(node, "@_type") ?? "";
    const medium = attr(node, "@_medium") ?? "";
    if (type && !type.startsWith("image/")) continue;
    if (medium && medium !== "image") continue;
    const cleaned = cleanImageUrl(url);
    if (cleaned) return cleaned;
  }
  return null;
}

/** 取某个字段的原始 HTML 字符串（fast-xml-parser 可能给出字符串或 {#text} 对象）。 */
function rawHtml(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(rawHtml).filter(Boolean).join(" ");
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if ("#text" in record) return rawHtml(record["#text"]);
  }
  return "";
}

const IMG_TAG = /<img\b[^>]*>/gi;
const IMG_SRC = /\bsrc\s*=\s*["']([^"']+)["']/i;
const TINY_SIZE = /\b(?:width|height)\s*=\s*["']?1["']?(?=[\s/>])/i;

/** 正文 HTML 里的第一张真实图片；跳过 1×1 追踪像素。 */
function htmlImage(html: string): string | null {
  if (!html) return null;
  for (const match of html.matchAll(IMG_TAG)) {
    const tag = match[0];
    if (TINY_SIZE.test(tag)) continue;
    const src = IMG_SRC.exec(tag)?.[1];
    const cleaned = cleanImageUrl(src);
    if (cleaned) return cleaned;
  }
  return null;
}

/** 提取条目配图：结构化节点优先，其次正文 HTML 的第一张图。 */
export function extractFeedImage(record: Record<string, unknown>): string | null {
  const structured = structuredImage(record);
  if (structured) return structured;
  for (const key of ["encoded", "description", "summary", "content"]) {
    const image = htmlImage(rawHtml(record[key]));
    if (image) return image;
  }
  return null;
}
