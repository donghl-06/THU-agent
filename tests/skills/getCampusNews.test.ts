/**
 * 校园动态/资讯 Skill 独立测试：假 ThuClient，不访问网络。
 */
import {describe, expect, it} from "vitest";
import type {NewsSlice} from "@thu-info/lib/dist/models/news/news";
import {ThuError} from "../../src/client/errors";
import {
    createGetCampusNewsSkill,
    type CampusNewsData,
} from "../../src/skills/news/getCampusNews";
import {
    createGetCampusNewsDetailSkill,
    type CampusNewsDetailData,
} from "../../src/skills/news/getCampusNewsDetail";

type ListResult = {success: boolean; data?: CampusNewsData; error?: {code: string; message: string}};
type DetailResult = {success: boolean; data?: CampusNewsDetailData; error?: {code: string; message: string}};

const makeNews = (title: string, url = `news-${title}.html`): NewsSlice => ({
    name: title,
    xxid: `xxid-${title}`,
    url,
    date: "2026-09-14",
    source: "教务处",
    topped: false,
    channel: "LM_JWGG",
    inFav: false,
});

describe("get_campus_news", () => {
    it("默认返回最近动态，并翻译栏目名", async () => {
        const calls: string[] = [];
        const skill = createGetCampusNewsSkill({
            getNewsList: async (page, limit, channel) => {
                calls.push(`list:${page}:${limit}:${channel ?? "all"}`);
                return [makeNews("2026年秋季选课通知")];
            },
            searchNewsList: async () => [],
        });
        const r = (await skill.execute({})) as ListResult;

        expect(r.success).toBe(true);
        expect(calls).toEqual(["list:1:10:all"]);
        expect(r.data!.mode).toBe("latest");
        expect(r.data!.items[0]).toMatchObject({
            title: "2026年秋季选课通知",
            channel: "LM_JWGG",
            channelName: "教务通知",
        });
        expect(r.data!.channels).toContainEqual({id: "LM_BYJYXX", name: "就业通知"});
    });

    it("提供关键词时走搜索接口，并保留栏目过滤", async () => {
        const calls: string[] = [];
        const skill = createGetCampusNewsSkill({
            getNewsList: async () => [],
            searchNewsList: async (page, keyword, channel) => {
                calls.push(`search:${page}:${keyword}:${channel}`);
                return [makeNews("研究生奖助学金通知")];
            },
        });
        const r = (await skill.execute({keyword: "奖助学金", channel: "LM_KYTZ"})) as ListResult;

        expect(r.success).toBe(true);
        expect(calls).toEqual(["search:1:奖助学金:LM_KYTZ"]);
        expect(r.data!.mode).toBe("search");
        expect(r.data!.keyword).toBe("奖助学金");
    });

    it("拒绝非法分页、条数、栏目和空关键词", async () => {
        const skill = createGetCampusNewsSkill({
            getNewsList: async () => [],
            searchNewsList: async () => [],
        });
        for (const input of [{page: 0}, {limit: 31}, {channel: "LM_NOT_EXISTS"}, {keyword: "   "}]) {
            const r = (await skill.execute(input)) as ListResult;
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
    });

    it("ThuError 转换为 SkillResult 错误", async () => {
        const skill = createGetCampusNewsSkill({
            getNewsList: async () => {
                throw new ThuError("AUTH_FAILED", "清华登录已过期");
            },
            searchNewsList: async () => [],
        });
        const r = (await skill.execute({})) as ListResult;
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("AUTH_FAILED");
    });
});

describe("get_campus_news_detail", () => {
    it("清洗 HTML 并解码实体", async () => {
        const skill = createGetCampusNewsDetailSkill({
            getNewsDetail: async () => [
                "关于举办&lt;AI&gt;比赛的通知",
                "<html><head><style>.x{color:red}</style></head><body><h1>比赛说明</h1><p>时间：9月19日&nbsp;9:00</p><script>alert(1)</script></body></html>",
                "<p>比赛介绍</p>",
            ],
        });
        const r = (await skill.execute({url: "news.html"})) as DetailResult;

        expect(r.success).toBe(true);
        expect(r.data!.kind).toBe("html");
        expect(r.data!.title).toBe("关于举办<AI>比赛的通知");
        expect(r.data!.content).toBe("比赛说明\n时间：9月19日 9:00");
        expect(r.data!.abstract).toBe("比赛介绍");
    });

    it("超长正文截断并标记", async () => {
        const skill = createGetCampusNewsDetailSkill({
            getNewsDetail: async () => ["长通知", `<p>${"很长的正文。".repeat(2000)}</p>`, ""],
        });
        const r = (await skill.execute({url: "long.html"})) as DetailResult;
        expect(r.data!.content).toHaveLength(8000);
        expect(r.data!.contentTruncated).toBe(true);
    });

    it("PDF 详情不返回大文件内容", async () => {
        const skill = createGetCampusNewsDetailSkill({
            getNewsDetail: async () => ["PdF", "JVBERi0xLjQK", "PdF"],
        });
        const r = (await skill.execute({url: "pdf.html"})) as DetailResult;
        expect(r.success).toBe(true);
        expect(r.data!.kind).toBe("pdf");
        expect(r.data!.content).toBe("");
        expect(r.data!.note).toContain("PDF");
    });

    it("拒绝空 url 并转换上游错误", async () => {
        const invalid = createGetCampusNewsDetailSkill({getNewsDetail: async () => ["", "", ""]});
        const empty = (await invalid.execute({url: " "})) as DetailResult;
        expect(empty.success).toBe(false);
        expect(empty.error!.code).toBe("INVALID_INPUT");

        const failing = createGetCampusNewsDetailSkill({
            getNewsDetail: async () => {
                throw new ThuError("UPSTREAM_ERROR", "详情页解析失败");
            },
        });
        const error = (await failing.execute({url: "bad.html"})) as DetailResult;
        expect(error.success).toBe(false);
        expect(error.error!.code).toBe("UPSTREAM_ERROR");
    });
});
