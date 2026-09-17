/**
 * Skill: preview_learn_file —— 把网络学堂的 PDF/PPT 课件下载落盘，并在对话里给预览卡片。
 *
 * 与 download_learn_file 的差别：除了保存文件，还把文件登记进 TempImageStore
 * 换对话内 URL，模型把返回的 markdown 原样写进回复，Web 端渲染预览卡片
 * （PDF 直接在卡片里翻阅；PPT 浏览器无法内嵌渲染，卡片给下载入口）。
 *
 * 落盘规则与 download_learn_file 一致：saveDir 省略时保存到用户的「下载」目录。
 * 文件是用户资产：用户在卡片旁点「已用完，删除」才从磁盘删除；预览链接本身
 * 有 TTL，过期只是不能再看，文件保留。
 *
 * 安全红线：真实写盘，requiresConfirmation = true，Harness 必须先向用户展示
 * 「下载哪个文件、保存到哪」并拿到明确同意。
 */
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {ThuError} from "../../client/errors";
import type {LearnClient} from "../../client/learn/LearnClient";
import {defaultDownloadDir, displayUserPath, resolveUserPath} from "../../utils/localPath";
import type {TempImageStore} from "../../utils/tempImageStore";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {courseDisplayName, resolveUniqueCourse, type CourseSource} from "./courseResolve";
import {matchLearnFile, sanitizeFilename} from "./downloadLearnFile";

/** 可预览课件的扩展名（学堂 content-type 常是 octet-stream，以扩展名/fileType 为准） */
const PREVIEW_EXT = /\.(pdf|pptx?)$/i;

/** 扩展名 → 服务端响应 content-type（PDF 让浏览器内嵌渲染，PPT 走下载） */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
    ".pdf": "application/pdf",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * 判定课件是否可预览，并给出规范扩展名（不带点，小写）。
 * 学堂课件列表的 title 和 remoteFile.name 经常都不带扩展名
 * （实测：「组成原理12-1 Instructions-thinpad」fileType="pdf"），
 * 所以 title / remoteName / fileType 三处都要看。
 */
function previewKind(title: string, remoteName: string, fileType: string): string | undefined {
    const byName = PREVIEW_EXT.exec(title)?.[1] ?? PREVIEW_EXT.exec(remoteName)?.[1];
    if (byName) return byName.toLowerCase();
    const kind = fileType.trim().toLowerCase();
    return /^(pdf|pptx?)$/.test(kind) ? kind : undefined;
}

export interface PreviewLearnFileData {
    course: string;
    title: string;
    savedPath: string;
    sizeBytes: number;
    fileUrl: string;
    markdown: string;
    note: string;
}

type PreviewSource = CourseSource & Pick<LearnClient, "getFileList" | "downloadFile">;

export function createPreviewLearnFileSkill(client: PreviewSource, files?: TempImageStore): Skill {
    return {
        name: "preview_learn_file",
        description:
            "预览网络学堂（learn.tsinghua.edu.cn）的 PDF/PPT 课件：先把课件下载到本地" +
            "（saveDir 省略时保存到用户的「下载」目录），再在对话里显示预览卡片——" +
            "PDF 直接在卡片里翻阅，PPT 卡片提供下载入口（浏览器无法内嵌渲染 PPT）。" +
            "course 课名关键词 + file 文件名关键词，都必须能唯一匹配。" +
            "成功后必须把返回的 markdown 字段原样写进回复，预览卡片才会显示；" +
            "文件已真实落盘，用户在卡片旁点「已用完，删除」才从磁盘删除。" +
            "只要下载不要预览时用 download_learn_file；图片课件用 show_learn_image。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                course: {
                    type: "string",
                    description: "课名关键词，必须能唯一匹配一门课，如“机器学习”",
                },
                file: {
                    type: "string",
                    description: "课件文件名关键词，必须能唯一匹配一个 PDF/PPT 课件，如“第三章课件”",
                },
                saveDir: {
                    type: "string",
                    description:
                        "可选，保存目录。支持 ~ 开头和 Windows 盘符路径（WSL 下自动翻译成 /mnt/盘符/...）；" +
                        "省略时保存到系统的「下载」目录（WSL 下是 Windows 的下载文件夹）",
                },
            },
            required: ["course", "file"],
        },

        async execute(input: unknown): Promise<SkillResult<PreviewLearnFileData>> {
            if (!files) {
                return fail("NOT_SUPPORTED", "当前环境不支持在对话中预览课件（只有 Web UI 提供预览通道）。");
            }
            const raw = (input ?? {}) as Record<string, unknown>;
            for (const k of ["course", "file"] as const) {
                if (typeof raw[k] !== "string" || !(raw[k] as string).trim()) {
                    return fail("INVALID_INPUT", `${k} 必填且必须是非空字符串`);
                }
            }
            if (raw.saveDir !== undefined && typeof raw.saveDir !== "string") {
                return fail("INVALID_INPUT", "saveDir 必须是字符串（目录绝对路径）");
            }

            try {
                const {course, error} = await resolveUniqueCourse(client, raw.course as string);
                if (error) return error;
                const courseName = courseDisplayName(course!);

                const list = await client.getFileList(course!.id);
                const {file, error: fileError} = matchLearnFile(list, raw.file as string, courseName);
                if (fileError) return fileError;

                // 可预览判定：title / remoteFile.name / fileType 三处任一命中即可
                const remoteName = file!.remoteFile?.name ?? "";
                const kind = previewKind(file!.title, remoteName, file!.fileType ?? "");
                if (!kind) {
                    return fail(
                        "INVALID_INPUT",
                        `「${file!.title}」不是 PDF/PPT 课件，无法在对话里预览。` +
                        `要下载到本地请用 download_learn_file；图片课件请用 show_learn_image。`,
                    );
                }

                // 归一化保存目录（~ 展开、Windows 盘符翻译），目录不存在时创建
                let saveDir: string;
                let pathNote: string | undefined;
                if (typeof raw.saveDir === "string" && raw.saveDir.trim()) {
                    const resolved = resolveUserPath(raw.saveDir);
                    if (!resolved.ok) return fail("INVALID_INPUT", resolved.error);
                    saveDir = resolved.path;
                    pathNote = resolved.note;
                } else {
                    saveDir = defaultDownloadDir();
                }
                await mkdir(saveDir, {recursive: true});

                const downloaded = await client.downloadFile(file!.downloadUrl);
                let filename = sanitizeFilename(downloaded.filename || remoteName || file!.title);
                // 学堂文件名可能不带扩展名（列表与下载响应都会），按判定结果补上
                if (!PREVIEW_EXT.test(filename)) filename += `.${kind}`;
                const savedPath = join(saveDir, filename);
                await writeFile(savedPath, downloaded.buffer);

                const ext = `.${(filename.split(".").pop() ?? "pdf").toLowerCase()}`;
                const contentType = CONTENT_TYPE_BY_EXT[ext] ?? "application/pdf";
                const {url: fileUrl} = files.register(savedPath, contentType, filename);
                return ok({
                    course: courseName,
                    title: file!.title,
                    savedPath,
                    sizeBytes: downloaded.buffer.length,
                    fileUrl,
                    markdown: `![file:${filename}](${fileUrl})`,
                    note:
                        `把 markdown 字段原样写进回复，用户会在对话里看到预览卡片` +
                        `（PDF 可直接翻阅，PPT 提供下载入口）。文件已保存到 ${displayUserPath(savedPath)}` +
                        (pathNote ? `（${pathNote}）` : "") +
                        `，用户在卡片旁点「已用完，删除」才从磁盘删除；预览链接过期不影响已保存的文件。`,
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
