/**
 * Skill: get_learn_notices —— 查询网络学堂的课程通知（公告）。
 *
 * 读操作扇出：course 省略时聚合本学期全部课程的通知；
 * 给了关键词就查匹配的课程（可匹配多门）。结果按发布时间倒序。
 */
import {ThuError} from "../../client/errors";
import type {LearnClient} from "../../client/learn/LearnClient";
import {extractInlineImages, type InlineImage} from "../../utils/htmlImages";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {courseDisplayName, resolveCourses, type CourseSource} from "./courseResolve";
import {formatBeijing} from "./format";

export interface LearnNoticesData {
    count: number;
    notices: {
        course: string;
        title: string;
        /** 纯文本正文（HTML 已剥除，正文内嵌图片留 [图片N] 占位） */
        content: string;
        /** 正文内嵌图片（老师直接贴在正文里的图，非附件）；下载需学堂登录态，可用 show_learn_image 显示 */
        images?: InlineImage[];
        publisher: string;
        publishTime: string;
        hasRead: boolean;
        markedImportant: boolean;
        /** 附件（课件/说明文档等），downloadUrl 需要学堂登录态 */
        attachment?: {name: string; size: string; downloadUrl: string};
    }[];
}

type NoticeSource = CourseSource & Pick<LearnClient, "getNotifications">;

/** 学堂域名：公告正文内嵌图片的相对路径按它解析成绝对 URL */
const LEARN_BASE_URL = "https://learn.tsinghua.edu.cn";

export function createGetLearnNoticesSkill(client: NoticeSource): Skill {
    return {
        name: "get_learn_notices",
        description:
            "查询网络学堂（learn.tsinghua.edu.cn）的课程通知/公告：标题、正文、发布人、时间、附件。" +
            "正文里直接贴的图片会提取到 images 字段（正文留 [图片N] 占位），用户要看图时用 show_learn_image 的 notice 参数显示。" +
            "course 给出课名关键词（如“数据结构”）时查对应课程，省略时聚合本学期全部课程的通知。" +
            "unreadOnly=true 只看未读。",
        inputSchema: {
            type: "object",
            properties: {
                course: {
                    type: "string",
                    description: "可选，课名/课号关键词，如“数据结构”；省略时查全部课程",
                },
                unreadOnly: {
                    type: "boolean",
                    description: "可选，true 时只返回未读通知，默认 false",
                },
                limit: {
                    type: "number",
                    description: "可选，最多返回多少条（按时间倒序），默认 20",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<LearnNoticesData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (raw.course !== undefined && typeof raw.course !== "string") {
                return fail("INVALID_INPUT", "course 必须是字符串（课名关键词）");
            }
            if (raw.unreadOnly !== undefined && typeof raw.unreadOnly !== "boolean") {
                return fail("INVALID_INPUT", "unreadOnly 必须是布尔值");
            }
            const limit = raw.limit === undefined ? 20 : Number(raw.limit);
            if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
                return fail("INVALID_INPUT", "limit 必须是 1-100 的整数");
            }
            try {
                const {result, error} = await resolveCourses(client, raw.course as string | undefined);
                if (error) return error;
                const perCourse = await Promise.all(
                    result!.courses.map(async (c) => ({
                        name: courseDisplayName(c),
                        notices: await client.getNotifications(c.id),
                    })),
                );
                const notices = perCourse
                    .flatMap(({name, notices}) =>
                        notices
                            .filter((n) => !raw.unreadOnly || !n.hasRead)
                            .map((n) => ({course: name, raw: n})),
                    )
                    // 先按 Date 倒序、截取后再格式化（locale 字符串不可排序）
                    .sort((a, b) => b.raw.publishTime.getTime() - a.raw.publishTime.getTime())
                    .slice(0, limit)
                    .map(({course, raw: n}) => {
                        const inline = extractInlineImages(n.content, LEARN_BASE_URL);
                        return {
                            course,
                            title: n.title,
                            content: inline.text,
                            ...(inline.images.length > 0 ? {images: inline.images} : {}),
                            publisher: n.publisher,
                            publishTime: formatBeijing(n.publishTime),
                            hasRead: n.hasRead,
                            markedImportant: n.markedImportant,
                            ...(n.attachment
                                ? {
                                    attachment: {
                                        name: n.attachment.name,
                                        size: n.attachment.size,
                                        downloadUrl: n.attachment.downloadUrl,
                                    },
                                }
                                : {}),
                        };
                    });
                if (notices.length === 0) {
                    return fail(
                        "NOT_FOUND",
                        raw.unreadOnly ? "没有未读的课程通知" : "没有查到课程通知",
                    );
                }
                return ok({count: notices.length, notices});
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
