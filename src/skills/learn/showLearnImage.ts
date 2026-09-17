/**
 * Skill: show_learn_image —— 把网络学堂的图片直接显示在对话里。
 *
 * 三种图片来源（file / notice / homework 三选一，都省略时自动选课件里唯一的图片）：
 *   1. 图片课件：course + file 文件名关键词（与 download_learn_file 同规则）
 *   2. 公告正文内嵌图：course + notice 公告标题关键词 + index 第几张（默认 1）
 *   3. 作业描述内嵌图：course + homework 作业标题关键词 + index 第几张（默认 1）
 *
 * 与 show_email_image 同一通道：下载字节 → TempImageStore 落临时文件换 URL →
 * 模型把返回的 markdown 原样写进回复 → 用户点图片旁「已用完」后服务端删本地文件。
 * 这是展示操作（不产生用户资产变化），不需要确认；要长期保存请用 download_learn_file。
 */
import type {File as LearnFile} from "thu-learn-lib";
import {ThuError} from "../../client/errors";
import type {LearnClient} from "../../client/learn/LearnClient";
import {extractInlineImages} from "../../utils/htmlImages";
import type {TempImageStore} from "../../utils/tempImageStore";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {courseDisplayName, resolveUniqueCourse, type CourseSource} from "./courseResolve";
import {matchLearnFile} from "./downloadLearnFile";

/** 单张图片上限（与 show_email_image 一致） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 学堂下载响应的 content-type 常是 octet-stream，用扩展名做图片兜底判定 */
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i;

/** 学堂域名：公告/作业正文内嵌图片的相对路径按它解析成绝对 URL */
const LEARN_BASE_URL = "https://learn.tsinghua.edu.cn";

export interface ShowLearnImageData {
    course: string;
    title: string;
    contentType: string;
    sizeBytes: number;
    imageUrl: string;
    markdown: string;
    note: string;
}

type ShowSource = CourseSource &
    Pick<LearnClient, "getFileList" | "downloadFile" | "getNotifications" | "getHomeworkList">;

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

/** 按标题关键词唯一匹配一条公告/作业（与 matchLearnFile 同规则：0 条 NOT_FOUND，多条 AMBIGUOUS） */
function matchByTitle<T extends {title: string}>(
    list: T[],
    keyword: string,
    kindLabel: string,
    courseName: string,
): {item?: T; error?: SkillResult<never>} {
    const kw = keyword.trim().toLowerCase();
    const matched = list.filter((x) => x.title.toLowerCase().includes(kw));
    if (matched.length === 0) {
        const titles = list.map((x) => x.title).slice(0, 10).join("、") || `（这门课还没有${kindLabel}）`;
        return {
            error: fail(
                "NOT_FOUND",
                `「${courseName}」找不到标题含“${keyword}”的${kindLabel}。现有${kindLabel}：${titles}${list.length > 10 ? " 等" : ""}`,
            ),
        };
    }
    if (matched.length > 1) {
        return {
            error: fail(
                "AMBIGUOUS",
                `“${keyword}”匹配到 ${matched.length} 条${kindLabel}：${matched.map((x) => x.title).slice(0, 10).join("、")}。请说更完整的标题。`,
            ),
        };
    }
    return {item: matched[0]};
}

/** 从富文本 HTML 里取第 index 张内嵌图（1 起始）；没有图或序号越界都给明确错误 */
function pickInlineImage(
    html: string | undefined,
    index: number,
    ownerLabel: string,
): {url?: string; error?: SkillResult<never>} {
    const {images} = extractInlineImages(html, LEARN_BASE_URL);
    if (images.length === 0) {
        return {error: fail("NOT_FOUND", `${ownerLabel}的正文里没有内嵌图片`)};
    }
    if (index > images.length) {
        return {
            error: fail(
                "INVALID_INPUT",
                `${ownerLabel}的正文里只有 ${images.length} 张图片，没有第 ${index} 张`,
            ),
        };
    }
    return {url: images[index - 1].url};
}

export function createShowLearnImageSkill(client: ShowSource, images?: TempImageStore): Skill {
    return {
        name: "show_learn_image",
        description:
            "把网络学堂（learn.tsinghua.edu.cn）的图片直接显示在对话里，三种来源三选一：" +
            "file 课件文件名关键词 / notice 公告标题关键词 / homework 作业标题关键词；" +
            "公告和作业是显示正文里直接贴的内嵌图，多图时用 index 指定第几张（默认 1，对应正文里的 [图片N]）；" +
            "公告的图在附件里时，notice 配 attachment=true 显示附件。" +
            "course 课名关键词必填；三个来源都省略且课件里只有一张图片时自动选中。" +
            "成功后必须把返回的 markdown 字段原样写进回复，图片才会显示；" +
            "图片是临时文件，用户在图片旁点「已用完」后服务端才删除。" +
            "PDF/PPT 课件预览用 preview_learn_file；其他非图片课件或要长期保存文件时，用 download_learn_file。",
        inputSchema: {
            type: "object",
            properties: {
                course: {
                    type: "string",
                    description: "课名关键词，必须能唯一匹配一门课，如“机器学习”",
                },
                file: {
                    type: "string",
                    description: "可选，课件文件名关键词，如“课程群二维码”；与 notice/homework 互斥",
                },
                notice: {
                    type: "string",
                    description: "可选，公告标题关键词，显示该公告正文里的内嵌图片（配 attachment=true 则显示公告附件）；与 file/homework 互斥",
                },
                homework: {
                    type: "string",
                    description: "可选，作业标题关键词，显示该作业描述里的内嵌图片；与 file/notice 互斥",
                },
                index: {
                    type: "number",
                    description: "可选，notice/homework 模式下正文里第几张图（1 起始，对应 [图片N]），默认 1",
                },
                attachment: {
                    type: "boolean",
                    description: "可选，仅配合 notice 使用：true 时显示公告的附件（而非正文内嵌图），默认 false",
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
            for (const key of ["file", "notice", "homework"] as const) {
                if (raw[key] !== undefined && typeof raw[key] !== "string") {
                    return fail("INVALID_INPUT", `${key} 必须是字符串`);
                }
            }
            const sources = (["file", "notice", "homework"] as const)
                .filter((k) => typeof raw[k] === "string" && (raw[k] as string).trim());
            if (sources.length > 1) {
                return fail("INVALID_INPUT", "file / notice / homework 三选一，不能同时给");
            }
            const index = raw.index === undefined ? 1 : Number(raw.index);
            if (!Number.isInteger(index) || index <= 0) {
                return fail("INVALID_INPUT", "index 必须是不小于 1 的整数（对应正文里的 [图片N]）");
            }
            if (raw.attachment !== undefined && typeof raw.attachment !== "boolean") {
                return fail("INVALID_INPUT", "attachment 必须是布尔值");
            }
            if (raw.attachment === true && !(typeof raw.notice === "string" && raw.notice.trim())) {
                return fail("INVALID_INPUT", "attachment=true 只配合 notice 使用（显示公告附件）");
            }

            try {
                const {course, error} = await resolveUniqueCourse(client, raw.course as string);
                if (error) return error;
                const courseName = courseDisplayName(course!);

                // 确定下载目标：标题（展示用）+ URL + 文件名兜底（扩展名判定用）
                let title: string;
                let url: string;
                let nameFallback: string;
                if (typeof raw.notice === "string" && raw.notice.trim()) {
                    const {item, error: e} = matchByTitle(
                        await client.getNotifications(course!.id), raw.notice, "公告", courseName,
                    );
                    if (e) return e;
                    if (raw.attachment === true) {
                        // 公告附件：老师把图当附件传的场景，downloadUrl 需登录态
                        if (!item!.attachment) {
                            return fail("NOT_FOUND", `公告「${item!.title}」没有附件`);
                        }
                        title = `${item!.title}（附件）`;
                        url = item!.attachment.downloadUrl;
                        nameFallback = item!.attachment.name;
                    } else {
                        const picked = pickInlineImage(item!.content, index, `公告「${item!.title}」`);
                        if (picked.error) return picked.error;
                        title = `${item!.title}（图片${index}）`;
                        url = picked.url!;
                        nameFallback = url;
                    }
                } else if (typeof raw.homework === "string" && raw.homework.trim()) {
                    const {item, error: e} = matchByTitle(
                        await client.getHomeworkList(course!.id), raw.homework, "作业", courseName,
                    );
                    if (e) return e;
                    const picked = pickInlineImage(item!.description, index, `作业「${item!.title}」`);
                    if (picked.error) return picked.error;
                    title = `${item!.title}（图片${index}）`;
                    url = picked.url!;
                    nameFallback = url;
                } else {
                    const list = await client.getFileList(course!.id);
                    const picked = typeof raw.file === "string" && raw.file.trim()
                        ? matchLearnFile(list, raw.file, courseName)
                        : pickUniqueImage(list, courseName);
                    if (picked.error) return picked.error;
                    title = picked.file!.title;
                    url = picked.file!.downloadUrl;
                    nameFallback = picked.file!.remoteFile?.name || picked.file!.title;
                }

                const downloaded = await client.downloadFile(url);
                const displayName = downloaded.filename || nameFallback;
                const isImage =
                    downloaded.contentType.startsWith("image/") || IMAGE_EXT.test(displayName);
                if (!isImage) {
                    const hint = /\.(pdf|pptx?)$/i.test(displayName)
                        ? "要下载到本地请用 download_learn_file；PDF/PPT 课件也可改用 preview_learn_file 在对话里预览。"
                        : "要下载到本地请用 download_learn_file。";
                    return fail("INVALID_INPUT", `「${title}」不是图片。${hint}`);
                }
                if (downloaded.buffer.length > MAX_IMAGE_BYTES) {
                    return fail("INVALID_INPUT", `图片太大（${Math.round(downloaded.buffer.length / 1024 / 1024)}MB），不在对话里显示。`);
                }
                // content-type 不可信时用扩展名归一化，保证浏览器正确渲染
                const contentType = downloaded.contentType.startsWith("image/")
                    ? downloaded.contentType
                    : displayName.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
                const {url: imageUrl} = images.put(downloaded.buffer, contentType, displayName);
                return ok({
                    course: courseName,
                    title,
                    contentType,
                    sizeBytes: downloaded.buffer.length,
                    imageUrl,
                    markdown: `![${title}](${imageUrl})`,
                    note: "把 markdown 字段原样写进回复，用户就能在对话里看到图片；图片为临时文件，用户在图片旁点「已用完」后服务端才从本地删除。",
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
