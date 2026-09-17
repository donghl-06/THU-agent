/**
 * Skill: upload_cloud_file —— 把本机文件上传到清华云盘。
 *
 * 这是真实写入用户云盘的操作，必须由 Harness 先向用户确认
 * 「本地文件、目标资料库、目标目录、目标文件名」。
 */
import {open, stat} from "node:fs/promises";
import {basename} from "node:path";
import type {CloudLibrary, CloudUploadFile} from "../../client/cloud/CloudClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {normalizeCloudPath, resolveCloudLibrary, validCloudName} from "./cloudResolve";

/** 以 1MB 分块流式提交，不在进程内存里整份缓存大文件。 */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

type CloudWriteSource = {
    listLibraries: () => Promise<CloudLibrary[]>;
    uploadFile: (repoId: string, parentDir: string, file: CloudUploadFile) => Promise<unknown>;
};

export interface UploadCloudFileData {
    library: CloudLibrary;
    parentDir: string;
    localFilePath: string;
    filename: string;
    cloudPath: string;
    sizeBytes: number;
    message: string;
}

export type LocalCloudFileLoader = (path: string, suggestedName?: string) => Promise<CloudUploadFile>;

export const defaultLocalCloudFileLoader: LocalCloudFileLoader = async (path, suggestedName) => {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("本地路径不是普通文件");
    if (info.size > MAX_UPLOAD_BYTES) {
        throw new Error(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
    }
    const handle = await open(path, "r");
    const buffer = Buffer.alloc(1024 * 1024);
    const content = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const {bytesRead} = await handle.read(buffer);
            if (bytesRead === 0) {
                await handle.close();
                controller.close();
                return;
            }
            controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
        },
        async cancel() {
            await handle.close().catch(() => undefined);
        },
    });
    return {
        name: suggestedName?.trim() || basename(path),
        sizeBytes: info.size,
        content,
    };
};

function uploadedFilename(result: unknown, fallback: string): string {
    if (Array.isArray(result)) {
        const first = result[0] as {name?: unknown; filename?: unknown} | undefined;
        const name = typeof first?.name === "string" && first.name.trim()
            ? first.name
            : typeof first?.filename === "string" && first.filename.trim()
                ? first.filename
                : undefined;
        if (name) return name;
    }
    return fallback;
}

export function createUploadCloudFileSkill(
    client: CloudWriteSource,
    loadLocalFile: LocalCloudFileLoader = defaultLocalCloudFileLoader,
): Skill {
    return {
        name: "upload_cloud_file",
        description:
            "把用户指定的本机文件上传到清华云盘（真实写操作，需确认）。" +
            "localFilePath 通常来自用户在聊天窗口上传附件后系统给出的本机路径。" +
            "library 填资料库名或 ID；folder 是目标目录，默认根目录 /；targetName 可选。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                localFilePath: {type: "string", description: "本机文件完整路径"},
                library: {type: "string", description: "目标资料库 ID 或唯一名称"},
                folder: {type: "string", description: "目标目录，默认 /"},
                targetName: {type: "string", description: "上传后的文件名；默认保留本地文件名"},
            },
            required: ["localFilePath", "library"],
        },

        async execute(input: unknown): Promise<SkillResult<UploadCloudFileData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.localFilePath !== "string" || !raw.localFilePath.trim()) {
                return fail("INVALID_INPUT", "localFilePath 必填且必须是非空本机路径");
            }
            if (typeof raw.library !== "string" || !raw.library.trim()) {
                return fail("INVALID_INPUT", "library 必填且必须是资料库 ID 或唯一名称");
            }
            if (raw.folder !== undefined && typeof raw.folder !== "string") {
                return fail("INVALID_INPUT", "folder 必须是字符串");
            }
            if (raw.targetName !== undefined && !validCloudName(raw.targetName)) {
                return fail("INVALID_INPUT", "targetName 不能包含路径分隔符或 Windows 保留字符");
            }
            const parentDir = normalizeCloudPath(raw.folder ?? "/");
            if (parentDir === undefined) {
                return fail("INVALID_INPUT", "folder 不能包含 . 或 .. 路径段");
            }

            try {
                const file = await loadLocalFile(raw.localFilePath, raw.targetName as string | undefined);
                const {library: targetLibrary, error: libraryError} =
                    await resolveCloudLibrary(client, String(raw.library));
                if (libraryError || !targetLibrary) return libraryError!;
                if (file.sizeBytes > MAX_UPLOAD_BYTES) {
                    return fail("INVALID_INPUT", `文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
                }

                const result = await client.uploadFile(targetLibrary.id, parentDir, file);
                const filename = uploadedFilename(result, file.name);
                const cloudPath = `${parentDir === "/" ? "" : parentDir}/${filename}`;
                return ok({
                    library: targetLibrary,
                    parentDir,
                    localFilePath: raw.localFilePath,
                    filename,
                    cloudPath,
                    sizeBytes: file.sizeBytes,
                    message: `已上传「${filename}」到「${targetLibrary.name}${cloudPath}」`,
                });
            } catch (error) {
                if (error instanceof ThuError) return fail(error.code, error.message);
                throw error;
            }
        },
    };
}
