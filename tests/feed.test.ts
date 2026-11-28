import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { describe, it } from "node:test";
import { fetchText } from "../src/lib/http";
import { parseFeed } from "../src/lib/parse/feed";
import { canonicalUrl } from "../src/lib/url";
import { EMPTY_RSS } from "./helpers";

function readFixture(name: string): string {
  return fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("RSS and Atom", () => {
  it("parses the captured V2EX Atom entry and strips the reply hash via canonical URL", () => {
    const [item] = parseFeed(readFixture("v2ex-public-sample.xml"));
    assert.equal(item?.title, "Anthropic 原生接口直通，新人入群送 10 美元");
    assert.equal(item?.url, "https://www.v2ex.com/t/1255325#reply0");
    assert.equal(canonicalUrl(item!.url), "https://www.v2ex.com/t/1255325");
    assert.equal(item?.publishedAt, Date.parse("2026-11-08T05:08:49Z"));
    assert.ok(item!.summary.length > 0);
  });

  it("decodes the captured 小众软件 RSS title instead of treating it as a deal keyword", () => {
    const [item] = parseFeed(readFixture("appinn-public-sample.xml"));
    assert.match(item!.title, /TotK Recomp/);
    assert.match(item!.title, /塞尔达传说/);
    assert.equal(item?.url, "https://www.appinn.com/totk-recomp/");
    assert.doesNotMatch(item!.title, /&#\d+;/);
  });

  it("keeps the captured 异次元 title and link", () => {
    const [item] = parseFeed(readFixture("iplaysoft-public-sample.xml"));
    assert.match(item!.title, /夸克网盘/);
    assert.equal(item?.url, "https://www.iplaysoft.com/p/quark-svip");
  });

  it("accepts a SYNTHETIC empty channel as zero items", () => {
    assert.deepEqual(parseFeed(EMPTY_RSS), []);
  });

  it("rejects a SYNTHETIC HTML challenge page", () => {
    assert.throws(() => parseFeed("<!doctype html><html><title>challenge</title></html>"), /网页|阻断/);
  });

  it("follows a 301 to the feed body", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/old") {
        res.writeHead(301, { Location: "/new" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(EMPTY_RSS);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const fetched = await fetchText(`http://127.0.0.1:${address.port}/old`, {
        fetchImpl: fetch,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(fetched.status, 200);
      assert.match(fetched.finalUrl, /\/new$/);
      assert.equal(parseFeed(fetched.body).length, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("feed images", () => {
  const rss = (inner: string) =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>t</title><item><title>SYNTHETIC 带图文章</title><link>https://www.ghxi.com/post-1</link><pubDate>Sun, 08 Nov 2026 05:00:00 GMT</pubDate>${inner}</item></channel></rss>`;

  it("extracts the first content image from content:encoded", () => {
    const [item] = parseFeed(rss(`<content:encoded><![CDATA[<p>正文</p><img src="https://img.example.com/cover.jpg" />]]></content:encoded>`));
    assert.equal(item?.image, "https://img.example.com/cover.jpg");
  });

  it("prefers media:thumbnail and upgrades http to https", () => {
    const [item] = parseFeed(rss(`<media:thumbnail url="http://img.example.com/thumb.jpg" /><content:encoded><![CDATA[<img src="https://img.example.com/body.jpg" />]]></content:encoded>`));
    assert.equal(item?.image, "https://img.example.com/thumb.jpg");
  });

  it("skips tracking pixels and emoji images", () => {
    const [item] = parseFeed(rss(`<content:encoded><![CDATA[<img src="https://img.example.com/pixel.gif" width="1" height="1" /><img src="https://img.example.com/emoji/smile.png" /><img src="https://img.example.com/real.jpg" />]]></content:encoded>`));
    assert.equal(item?.image, "https://img.example.com/real.jpg");
  });

  it("returns a null image when the feed carries none", () => {
    const [item] = parseFeed(rss(`<description>纯文字摘要</description>`));
    assert.equal(item?.image, null);
  });
});
