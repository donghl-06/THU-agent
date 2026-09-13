/**
 * Skill: download_learn_file —— 把网络学堂课件下载到本地（写操作，落盘）。
 *
 * 安全红线：requiresConfirmation = true，Harness 必须先向用户展示
 * 「下载哪个文件、保存到哪」并拿到明确同意。
 *
 * 文件必须唯一匹配（课程 + 文件名两级关键词），歧义时报 AMBIGUOUS。
 * 下载走 LearnClient 的独立下载会话（带学堂登录态），链接直接给浏览器
 * 无法绕过登录，所以本地保存必须经过这个技能。
 */
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import type {File as LearnFile} from "thu-learn-lib";
import {ThuError} from "../../client/errors";
import type {LearnClient} from "../../client/learn/LearnClient";
import {defaultDownloadDir, resolveUserPath} from "../../utils/localPath";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {courseDisplayName, resolveUniqueCourse, type CourseSource} from "./courseResolve";

export interface DownloadLearnFileData {
    course: string;
    title: string;
    savedPath: string;
    sizeBytes: number;
    message: string;
}

type DownloadSource = CourseSource & Pick<LearnClient, "getFileList" | "downloadFile">;

/** 文件名清洗：去掉路径分隔符与控制字符，防止写穿目录 */
function sanitizeFilename(name: string): string {
    return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "download";
}

/** 文件名关键词唯一匹配（写操作规则同课程匹配） */
function matchFile(
    list: LearnFile[],
    keyword: string,
    courseName: string,
): {file?: LearnFile; error?: SkillResult<never>} {
    const kw = keyword.trim().toLowerCase();
    const matched = list.filter((f) => f.title.toLowerCase().includes(kw));
    if (matched.length === 0) {
        const titles = list.map((f) => f.title).slice(0, 10).join("、") || "（这门课还没有课件）";
        return {
            error: fail(
                "NOT_FOUND",
                `「${courseName}」找不到文件名含“${keyword}”的课件。现有课件：${titles}${list.length > 10 ? " 等" : ""}`,
            ),
        };
    }
    if (matched.length > 1) {
        return {
            error: fail(
                "AMBIGUOUS",
                `“${keyword}”匹配到 ${matched.length} 个文件：${matched.map((f) => f.title).slice(0, 10).join("、")}。请说更完整的文件名。`,
            ),
        };
    }
    return {file: matched[0]};
}

export function createDownloadLearnFileSkill(client: DownloadSource): Skill {
    return {
        name: "download_learn_file",
        description:
            "把网络学堂（learn.tsinghua.edu.cn）的课件文件下载到本地目录（写操作，真实落盘）。" +
            "课程和文件名都必须是能唯一匹配的关键词；拿不准时先用 get_learn_files 确认。" +
            "saveDir 省略时保存到用户的 Downloads 目录。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                course: {
                    type: "string",
                    description: "课名关键词，必须能唯一匹配一门课，如“数据结构”",
                },
                file: {
                    type: "string",
                    description: "文件名关键词，必须能唯一匹配一个课件，如“第三章课件”",
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

        async execute(input: unknown): Promise<SkillResult<DownloadLearnFileData>> {
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
                const {file, error: fileError} = matchFile(list, raw.file as string, courseName);
                if (fileError) return fileError;

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
                const filename = sanitizeFilename(
                    downloaded.filename || file!.remoteFile?.name || file!.title,
                );
                const savedPath = join(saveDir, filename);
                await writeFile(savedPath, downloaded.buffer);

                return ok({
                    course: courseName,
                    title: file!.title,
                    savedPath,
                    sizeBytes: downloaded.buffer.length,
                    message:
                        `已下载「${courseName}」的课件 ${file!.title} → ${savedPath}` +
                        (pathNote ? `（${pathNote}）` : ""),
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
