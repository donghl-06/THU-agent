/**
 * Skill: show_learn_image —— 把网络学堂的图片课件直接显示在对话里。
 *
 * 与 show_email_image 同一通道：下载字节 → TempImageStore 落临时文件换 URL →
 * 模型把返回的 markdown 原样写进回复 → 用户点图片旁「已用完」后服务端删本地文件。
 * 课程 + 文件名两级关键词唯一匹配（与 download_learn_file 同规则），歧义报 AMBIGUOUS。
 * 这是展示操作（不产生用户资产变化），不需要确认；要长期保存请用 download_learn_file。
 */
import type {File as LearnFile} from "thu-learn-lib";
import {ThuError} from "../../client/errors";
import type {LearnClient} from "../../client/learn/LearnClient";
import type {TempImageStore} from "../../utils/tempImageStore";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {courseDisplayName, resolveUniqueCourse, type CourseSource} from "./courseResolve";
import {matchLearnFile} from "./downloadLearnFile";

/** 单张图片上限（与 show_email_image 一致） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 学堂下载响应的 content-type 常是 octet-stream，用扩展名做图片兜底判定 */
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i;

export interface ShowLearnImageData {
    course: string;
    title: string;
    contentType: string;
    sizeBytes: number;
    imageUrl: string;
    markdown: string;
    note: string;
}

type ShowSource = CourseSource & Pick<LearnClient, "getFileList" | "downloadFile">;

/** 从课件列表里挑出唯一的图片课件（无关键词时）；0 张 NOT_FOUND，多张 AMBIGUOUS */
function pickUniqueImage(
    list: LearnFile[],
    courseName: string,
): {file?: LearnFile; error?: SkillResult<never>} {
    const images = list.filter((f) => IMAGE_EXT.test(f.title) || IMAGE_EXT.test(f.remoteFile?.name ?? ""));
    if (images.length === 0) {
        return {error: fail("NOT_FOUND", `「${courseName}」的课件里没有图片文件（可用 file 参数指定文件名试试）`)};
    }
    if (images.length > 1) {
        const titles = images.map((f) => f.title).slice(0, 10).join("、");
        return {error: fail("AMBIGUOUS", `「${courseName}」有 ${images.length} 个图片课件：${titles}。请用 file 参数指定。`)};
    }
    return {file: images[0]};
}

export function createShowLearnImageSkill(client: ShowSource, images?: TempImageStore): Skill {
    return {
        name: "show_learn_image",
        description:
            "把网络学堂（learn.tsinghua.edu.cn）的图片课件（二维码、照片、截图等）直接显示在对话里。" +
            "course 课名关键词必填；file 文件名关键词可选（省略且课件里只有一张图片时自动选中）。" +
            "成功后必须把返回的 markdown 字段原样写进回复，图片才会显示；" +
            "图片是临时文件，用户在图片旁点「已用完」后服务端才删除。" +
            "非图片课件或要长期保存文件时，用 download_learn_file。",
        inputSchema: {
            type: "object",
            properties: {
                course: {
                    type: "string",
                    description: "课名关键词，必须能唯一匹配一门课，如“机器学习”",
                },
                file: {
                    type: "string",
                    description: "可选，文件名关键词；多张图片时用来指定，如“课程群二维码”",
                },
            },
            required: ["course"],
        },

        async execute(input: unknown): Promise<SkillResult<ShowLearnImageData>> {
            if (!images) {
                return fail("NOT_SUPPORTED", "当前环境不支持在对话中显示图片（只有 Web UI 提供图片通道）。");
            }
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.course !== "string" || !raw.course.trim()) {
                return fail("INVALID_INPUT", "course 必填且必须是非空字符串");
            }
            if (raw.file !== undefined && typeof raw.file !== "string") {
                return fail("INVALID_INPUT", "file 必须是字符串");
            }

            try {
                const {course, error} = await resolveUniqueCourse(client, raw.course as string);
                if (error) return error;
                const courseName = courseDisplayName(course!);

                const list = await client.getFileList(course!.id);
                const picked = typeof raw.file === "string" && raw.file.trim()
                    ? matchLearnFile(list, raw.file, courseName)
                    : pickUniqueImage(list, courseName);
                if (picked.error) return picked.error;
                const file = picked.file!;

                const downloaded = await client.downloadFile(file.downloadUrl);
                const displayName = downloaded.filename || file.remoteFile?.name || file.title;
                const isImage =
                    downloaded.contentType.startsWith("image/") || IMAGE_EXT.test(displayName);
                if (!isImage) {
                    return fail(
                        "INVALID_INPUT",
                        `课件「${file.title}」不是图片。要下载到本地请用 download_learn_file。`,
                    );
                }
                if (downloaded.buffer.length > MAX_IMAGE_BYTES) {
                    return fail("INVALID_INPUT", `图片太大（${Math.round(downloaded.buffer.length / 1024 / 1024)}MB），不在对话里显示。`);
                }
                // content-type 不可信时用扩展名归一化，保证浏览器正确渲染
                const contentType = downloaded.contentType.startsWith("image/")
                    ? downloaded.contentType
                    : displayName.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
                const {url} = images.put(downloaded.buffer, contentType, displayName);
                return ok({
                    course: courseName,
                    title: file.title,
                    contentType,
                    sizeBytes: downloaded.buffer.length,
                    imageUrl: url,
                    markdown: `![${file.title}](${url})`,
                    note: "把 markdown 字段原样写进回复，用户就能在对话里看到图片；图片为临时文件，用户在图片旁点「已用完」后服务端才从本地删除。",
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
