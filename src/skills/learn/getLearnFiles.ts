/**
 * Skill: get_learn_files —— 查询网络学堂的课件文件列表。
 *
 * 只读：返回文件名/大小/上传时间/下载链接（链接需要学堂登录态，
 * 在已登录学堂的浏览器里可直接打开）。要把文件下载到本地用 download_learn_file。
 */
import {ThuError} from "../../client/errors";
import type {LearnClient} from "../../client/learn/LearnClient";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {courseDisplayName, resolveCourses, type CourseSource} from "./courseResolve";
import {formatBeijing} from "./format";

export interface LearnFilesData {
    count: number;
    files: {
        course: string;
        /** 所属分类（课件/参考资料等，老师建的目录） */
        category?: string;
        title: string;
        description?: string;
        fileType: string;
        size: string;
        uploadTime: string;
        isNew: boolean;
        downloadUrl: string;
    }[];
}

type FileSource = CourseSource & Pick<LearnClient, "getFileList">;

export function createGetLearnFilesSkill(client: FileSource): Skill {
    return {
        name: "get_learn_files",
        description:
            "查询网络学堂（learn.tsinghua.edu.cn）的课件文件列表：文件名、分类、大小、上传时间、下载链接。" +
            "course 给课名关键词查对应课程，省略时聚合本学期全部课程。" +
            "keyword 可按文件名过滤。下载链接需要学堂登录态；要直接下载到本地请用 download_learn_file。",
        inputSchema: {
            type: "object",
            properties: {
                course: {
                    type: "string",
                    description: "可选，课名/课号关键词，如“数据结构”；省略时查全部课程",
                },
                keyword: {
                    type: "string",
                    description: "可选，文件名关键词过滤，如“第三章”",
                },
                limit: {
                    type: "number",
                    description: "可选，最多返回多少个（按上传时间倒序），默认 30",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<LearnFilesData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            for (const k of ["course", "keyword"] as const) {
                if (raw[k] !== undefined && typeof raw[k] !== "string") {
                    return fail("INVALID_INPUT", `${k} 必须是字符串`);
                }
            }
            const limit = raw.limit === undefined ? 30 : Number(raw.limit);
            if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
                return fail("INVALID_INPUT", "limit 必须是 1-200 的整数");
            }
            try {
                const {result, error} = await resolveCourses(client, raw.course as string | undefined);
                if (error) return error;
                const perCourse = await Promise.all(
                    result!.courses.map(async (c) => ({
                        name: courseDisplayName(c),
                        files: await client.getFileList(c.id),
                    })),
                );
                const kw = (raw.keyword as string | undefined)?.trim().toLowerCase();
                const files = perCourse
                    .flatMap(({name, files}) =>
                        files
                            .filter((f) => !kw || f.title.toLowerCase().includes(kw))
                            .map((f) => ({course: name, raw: f})),
                    )
                    .sort((a, b) => b.raw.uploadTime.getTime() - a.raw.uploadTime.getTime())
                    .slice(0, limit)
                    .map(({course, raw: f}) => ({
                        course,
                        ...(f.category?.title ? {category: f.category.title} : {}),
                        title: f.title,
                        ...(f.description ? {description: f.description} : {}),
                        fileType: f.fileType,
                        size: f.size,
                        uploadTime: formatBeijing(f.uploadTime),
                        isNew: f.isNew,
                        downloadUrl: f.downloadUrl,
                    }));
                if (files.length === 0) {
                    return fail(
                        "NOT_FOUND",
                        kw ? `找不到文件名含“${raw.keyword}”的课件` : "没有查到课件文件",
                    );
                }
                return ok({count: files.length, files});
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
