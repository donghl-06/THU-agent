/**
 * Skill: show_cloud_file —— 在对话中打开清华云盘文件。
 *
 * 图片走与邮件/学堂图片一致的本地临时文件通道；视频、音频和普通文件
 * 不整包落盘，由本地服务按 Range 请求代理云盘内容并支持用户主动清理预览。
 */
import type {CloudFile, CloudLibrary, CloudSearchResult} from "../../client/cloud/CloudClient";
import {ThuError} from "../../client/errors";
import type {CloudFileStore} from "../../utils/cloudFileStore";
import type {TempImageStore} from "../../utils/tempImageStore";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

const VIDEO_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|oga|flac|aac)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CLOUD_BASE = "https://cloud.tsinghua.edu.cn";

interface CloudPreviewStores {
    images?: TempImageStore;
    cloudFiles?: CloudFileStore;
}

type CloudFileSource = {
    listLibraries: () => Promise<CloudLibrary[]>;
    searchFiles: (keyword: string) => Promise<CloudSearchResult[]>;
    getFileDetail: (repoId: string, path: string) => Promise<CloudFile>;
    getFileDownloadUrl: (repoId: string, path: string) => Promise<string>;
    downloadFileByUrl: (accessUrl: string) => Promise<{buffer: Buffer; contentType: string}>;
};

export interface ShowCloudFileData {
    library: CloudLibrary;
    file: CloudFile;
    mediaType: "video" | "audio" | "image" | "file";
    /** 文件服务器访问链接。reuse=1，可在有效期内多次用于播放/下载。 */
    accessUrl: string;
    /** 云盘网页端位置，供浏览器不支持该编码时兜底。 */
    webUrl: string;
    /** 图片的本地临时 URL；非图片为空。 */
    imageUrl?: string;
    /** 视频/音频/普通文件的本地受控预览 URL；图片为空。 */
    previewUrl?: string;
    /** 原样写进最终回复即可渲染视频/音频/文件卡片。 */
    markdown: string;
    note: string;
}

function normalizeCloudPath(input: unknown): string | undefined {
    if (typeof input !== "string" || !input.trim()) return undefined;
    const withSlash = input.trim().startsWith("/") ? input.trim() : `/${input.trim()}`;
    const parts = withSlash.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) return undefined;
    return `/${parts.join("/")}`;
}

function mediaType(name: string): ShowCloudFileData["mediaType"] {
    if (VIDEO_EXT.test(name)) return "video";
    if (AUDIO_EXT.test(name)) return "audio";
    if (IMAGE_EXT.test(name)) return "image";
    return "file";
}

function markdownAlt(name: string): string {
    return name.replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function cloudWebUrl(repoId: string, path: string): string {
    const encodedPath = path
        .split("/")
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/");
    return `${CLOUD_BASE}/lib/${encodeURIComponent(repoId)}/file/${encodedPath}`;
}

function markdownImage(alt: string, url: string): string {
    return `![${alt}](${url})`;
}

async function resolveLibrary(
    client: CloudFileSource,
    keyword: string,
): Promise<{library?: CloudLibrary; error?: SkillResult<never>}> {
    const libraries = await client.listLibraries();
    const exactId = libraries.filter((item) => item.id === keyword);
    const matched = exactId.length > 0 ? exactId : libraries.filter((item) =>
        item.name.toLowerCase() === keyword.toLowerCase()
    );
    if (matched.length === 0) {
        return {error: fail(
            "NOT_FOUND",
            `清华云盘中没有名为「${keyword}」的资料库。请先调用 get_cloud_libraries 查看可用资料库。`,
        )};
    }
    if (matched.length > 1) {
        return {error: fail(
            "AMBIGUOUS",
            `「${keyword}」匹配到 ${matched.length} 个云盘资料库：` +
            matched.slice(0, 10).map((item) => item.name).join("、") +
            "。请使用资料库 ID 或更完整的名称。",
        )};
    }
    return {library: matched[0]};
}

async function resolveFileByKeyword(
    client: CloudFileSource,
    library: CloudLibrary,
    keyword: string,
): Promise<{path?: string; error?: SkillResult<never>}> {
    const results = (await client.searchFiles(keyword))
        .filter((item) => item.isFile && item.repoId === library.id);
    const exact = results.filter((item) => item.name.toLowerCase() === keyword.toLowerCase());
    const candidates = exact.length > 0 ? exact : results;
    if (candidates.length === 0) {
        return {error: fail(
            "NOT_FOUND",
            `「${library.name}」里没有找到文件名含“${keyword}”的文件。可先调用 search_cloud_files 确认。`,
        )};
    }
    if (candidates.length > 1) {
        return {error: fail(
            "AMBIGUOUS",
            `“${keyword}”在「${library.name}」匹配到 ${candidates.length} 个文件：` +
            candidates.slice(0, 10).map((item) => item.name).join("、") +
            "。请给 path 传完整路径，或用更完整的文件名。",
        )};
    }
    return {path: candidates[0].path};
}

export function createShowCloudFileSkill(client: CloudFileSource, stores: CloudPreviewStores = {}): Skill {
    return {
        name: "show_cloud_file",
        description:
            "在对话中打开清华云盘文件。图片直接预览；video/audio 显示播放器；普通文件显示文件卡片。" +
            "Web 中内容经本地受控预览通道显示，用户可一键清理；不会把大文件整包下载到本地。" +
            "library 填资料库 ID 或唯一名称；path 填完整路径；不知道路径时可传 file 文件名关键词。" +
            "成功后必须把返回的 markdown 字段原样写进回复，图片/播放器/文件卡片才会显示。",
        inputSchema: {
            type: "object",
            properties: {
                library: {
                    type: "string",
                    description: "资料库 ID 或资料库名称",
                },
                path: {
                    type: "string",
                    description: "云盘内完整路径，如 /2025010550.mp4",
                },
                file: {
                    type: "string",
                    description: "文件名关键词；与 path 二选一，用于搜索后唯一定位",
                },
            },
            required: ["library"],
        },

        async execute(input: unknown): Promise<SkillResult<ShowCloudFileData>> {
            const raw = (input ?? {}) as {library?: unknown; path?: unknown; file?: unknown};
            if (typeof raw.library !== "string" || !raw.library.trim()) {
                return fail("INVALID_INPUT", "library 必填且必须是非空字符串（资料库 ID 或名称）");
            }
            if (raw.path !== undefined && typeof raw.path !== "string") {
                return fail("INVALID_INPUT", "path 必须是字符串");
            }
            if (raw.file !== undefined && typeof raw.file !== "string") {
                return fail("INVALID_INPUT", "file 必须是字符串");
            }
            if ((typeof raw.path === "string" && raw.path.trim()) &&
                (typeof raw.file === "string" && raw.file.trim())) {
                return fail("INVALID_INPUT", "path 和 file 二选一，不能同时提供");
            }

            const path = normalizeCloudPath(raw.path);
            if (raw.path !== undefined && !path) {
                return fail("INVALID_INPUT", "path 不能为空，且不能包含 . 或 .. 路径段");
            }
            const fileKeyword = typeof raw.file === "string" ? raw.file.trim() : "";
            if (!path && !fileKeyword) {
                return fail("INVALID_INPUT", "path 和 file 至少提供一个");
            }

            let targetPath = path;
            try {
                const {library, error} = await resolveLibrary(client, raw.library as string);
                if (error || !library) return error!;

                if (!targetPath) {
                    const picked = await resolveFileByKeyword(client, library, fileKeyword);
                    if (picked.error || !picked.path) return picked.error!;
                    targetPath = picked.path;
                }

                const [file, accessUrl] = await Promise.all([
                    client.getFileDetail(library.id, targetPath),
                    client.getFileDownloadUrl(library.id, targetPath),
                ]);
                const type = mediaType(file.name);
                const alt = markdownAlt(file.name);
                let markdown: string;
                let imageUrl: string | undefined;
                let previewUrl: string | undefined;
                let note: string;

                if (type === "image" && stores.images) {
                    if ((file.sizeBytes ?? 0) > MAX_IMAGE_BYTES) {
                        return fail("INVALID_INPUT", `图片「${file.name}」超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB，暂不支持直接预览；可让它生成分享链接或到云盘网页端查看。`);
                    }
                    const {buffer, contentType} = await client.downloadFileByUrl(accessUrl);
                    if (buffer.length > MAX_IMAGE_BYTES) {
                        return fail("INVALID_INPUT", `图片「${file.name}」实际大小超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB，暂不支持直接预览。`);
                    }
                    if (!contentType.startsWith("image/") || !IMAGE_EXT.test(file.name)) {
                        return fail("INVALID_INPUT", `云盘返回的「${file.name}」不是可安全预览的图片。`);
                    }
                    const image = stores.images.put(buffer, contentType, file.name);
                    imageUrl = image.url;
                    markdown = markdownImage(alt, imageUrl);
                    note = "把 markdown 字段原样写进回复，Web UI 会直接显示图片；用户点「已用完，删除图片」后会清理本地临时文件。";
                } else if (type !== "image" && stores.cloudFiles) {
                    const preview = stores.cloudFiles.put(accessUrl, file.name, type);
                    previewUrl = preview.url;
                    markdown = `![${type}:${alt}](${previewUrl})`;
                    note = "把 markdown 字段原样写进回复，Web UI 会显示播放器/文件卡片；用户点删除按钮只会清理本地预览，不会删除云盘文件。";
                } else {
                    // CLI/MCP 没有 Web 预览通道：保留云盘签发的临时直链，由调用方按需下载。
                    markdown = type === "file"
                        ? `[下载「${alt}」](${accessUrl})`
                        : `![${type}:${alt}](${accessUrl})`;
                    note = "当前运行环境没有本地预览通道，把 markdown 字段原样写进回复；链接由云盘签发，过期后需重新调用本工具。";
                }

                return ok({
                    library,
                    file,
                    mediaType: type,
                    accessUrl,
                    webUrl: cloudWebUrl(library.id, file.path),
                    imageUrl,
                    previewUrl,
                    markdown,
                    note,
                });
            } catch (error) {
                if (error instanceof ThuError) {
                    if (error.code === "UPSTREAM_ERROR" && error.message.includes("404")) {
                        return fail("NOT_FOUND", `云盘文件不存在或无权访问：${targetPath ?? fileKeyword}`);
                    }
                    return fail(error.code, error.message);
                }
                throw error;
            }
        },
    };
}
