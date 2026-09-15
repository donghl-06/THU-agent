/**
 * Skill: get_campus_news —— 查询校园动态/资讯列表。
 *
 * 数据源是 THU Info App 的“动态”接口。这里保持只读，并把上游栏目 ID
 * 翻译成中文，方便模型理解用户说“教务通知”“就业通知”时该选哪个栏目。
 */
import type {ChannelTag, NewsSlice} from "@thu-info/lib/dist/models/news/news";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export const NEWS_CHANNEL_NAMES: Record<ChannelTag, string> = {
    LM_BGTG: "办公通知",
    LM_ZYGG: "重要公告",
    LM_YQFKZT: "疫情防控专题",
    LM_JWGG: "教务通知",
    LM_KYTZ: "科研通知",
    LM_HB: "海报",
    LM_XJ_XTWBGTZ: "校团委通知",
    LM_XSBGGG: "学生工作通知",
    LM_TTGGG: "图书馆信息",
    LM_JYGG: "学生社区通知",
    LM_XJ_XSSQDT: "学生社区动态",
    LM_BYJYXX: "就业通知",
    LM_JYZPXX: "招聘信息",
    LM_XJ_GJZZSXRZ: "国际组织实习任职",
};

export interface CampusNewsItem {
    title: string;
    date: string;
    source: string;
    channel: ChannelTag;
    channelName: string;
    topped: boolean;
    /** 详情接口需要的标识，必须原样传给 get_campus_news_detail */
    url: string;
}

export interface CampusNewsData {
    mode: "latest" | "search";
    page: number;
    limit: number;
    keyword?: string;
    items: CampusNewsItem[];
    channels: Array<{id: ChannelTag; name: string}>;
}

type NewsListSource = {
    getNewsList: (page: number, length: number, channel?: ChannelTag) => Promise<NewsSlice[]>;
    searchNewsList: (page: number, key: string, channel?: ChannelTag) => Promise<NewsSlice[]>;
};

const MAX_LIMIT = 30;

function normalizeNews(item: NewsSlice): CampusNewsItem {
    return {
        title: item.name.trim(),
        date: item.date,
        source: item.source,
        channel: item.channel,
        channelName: NEWS_CHANNEL_NAMES[item.channel] ?? item.channel,
        topped: item.topped,
        url: item.url,
    };
}

export function createGetCampusNewsSkill(client: NewsListSource): Skill {
    const channels = (Object.keys(NEWS_CHANNEL_NAMES) as ChannelTag[]).map((id) => ({
        id,
        name: NEWS_CHANNEL_NAMES[id],
    }));
    const channelDescription = channels.map(({id, name}) => `${id}（${name}）`).join("、");

    return {
        name: "get_campus_news",
        description:
            "查询 THU Info 校园动态/资讯：支持浏览最近通知、公告、海报，也支持按关键词搜索。" +
            "用户问“最近有什么通知/资讯/公告”“有没有xx相关的动态”时使用。" +
            "返回的 url 是查看详情的临时标识，必须原样传给 get_campus_news_detail。",
        inputSchema: {
            type: "object",
            properties: {
                page: {
                    type: "integer",
                    minimum: 1,
                    description: "页码，从 1 开始，默认 1",
                },
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: MAX_LIMIT,
                    description: `每页条数，默认 10，最大 ${MAX_LIMIT}`,
                },
                channel: {
                    type: "string",
                    enum: channels.map(({id}) => id),
                    description: `可选栏目：${channelDescription}`,
                },
                keyword: {
                    type: "string",
                    description: "可选关键词；提供时走搜索接口，省略时浏览最近动态",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<CampusNewsData>> {
            const raw = (input ?? {}) as {
                page?: unknown;
                limit?: unknown;
                channel?: unknown;
                keyword?: unknown;
            };

            if (raw.page !== undefined && (
                typeof raw.page !== "number" || !Number.isInteger(raw.page) || raw.page < 1
            )) {
                return fail("INVALID_INPUT", "page 必须是不小于 1 的整数");
            }
            if (raw.limit !== undefined && (
                typeof raw.limit !== "number" ||
                !Number.isInteger(raw.limit) ||
                raw.limit < 1 ||
                raw.limit > MAX_LIMIT
            )) {
                return fail("INVALID_INPUT", `limit 必须是 1-${MAX_LIMIT} 之间的整数`);
            }
            if (raw.channel !== undefined && !channels.some(({id}) => id === raw.channel)) {
                return fail("INVALID_INPUT", `channel 必须是以下之一：${channelDescription}`);
            }
            if (raw.keyword !== undefined && (
                typeof raw.keyword !== "string" || raw.keyword.trim().length === 0
            )) {
                return fail("INVALID_INPUT", "keyword 必须是非空字符串；浏览最近动态时请省略该参数");
            }
            if (typeof raw.keyword === "string" && raw.keyword.trim().length > 80) {
                return fail("INVALID_INPUT", "keyword 过长，请控制在 80 个字符以内");
            }

            const page = typeof raw.page === "number" ? raw.page : 1;
            const limit = typeof raw.limit === "number" ? raw.limit : 10;
            const channel = raw.channel as ChannelTag | undefined;
            const keyword = typeof raw.keyword === "string" ? raw.keyword.trim() : undefined;

            try {
                const upstreamItems = keyword === undefined
                    ? await client.getNewsList(page, limit, channel)
                    : await client.searchNewsList(page, keyword, channel);
                const items = upstreamItems.map(normalizeNews);

                return ok({
                    mode: keyword === undefined ? "latest" : "search",
                    page,
                    limit,
                    ...(keyword === undefined ? {} : {keyword}),
                    items,
                    channels,
                });
            } catch (e) {
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e;
            }
        },
    };
}
