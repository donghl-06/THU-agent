/**
 * Skill: create_cloud_folder —— 在清华云盘创建文件夹。
 * 支持递归创建父目录，但仍是真实写操作，必须先确认。
 */
import type {CloudLibrary} from "../../client/cloud/CloudClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {normalizeCloudPath, resolveCloudLibrary} from "./cloudResolve";

type CloudFolderSource = {
    listLibraries: () => Promise<CloudLibrary[]>;
    createFolder: (repoId: string, path: string) => Promise<string>;
};

export interface CreateCloudFolderData {
    library: CloudLibrary;
    path: string;
    message: string;
}

export function createCreateCloudFolderSkill(client: CloudFolderSource): Skill {
    return {
        name: "create_cloud_folder",
        description:
            "在清华云盘资料库中创建文件夹（真实写操作，需确认）。" +
            "path 是包含新文件夹在内的完整路径，如 /课件/大三上；父目录不存在时会一并创建。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                library: {type: "string", description: "资料库 ID 或唯一名称"},
                path: {type: "string", description: "要创建的完整文件夹路径，不能是 /"},
            },
            required: ["library", "path"],
        },

        async execute(input: unknown): Promise<SkillResult<CreateCloudFolderData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.library !== "string" || !raw.library.trim()) {
                return fail("INVALID_INPUT", "library 必填且必须是非空字符串");
            }
            const path = normalizeCloudPath(raw.path);
            if (typeof raw.path !== "string" || path === undefined || path === "/") {
                return fail("INVALID_INPUT", "path 必须是有效的非根目录路径，且不能包含 . 或 ..");
            }

            try {
                const {library, error} = await resolveCloudLibrary(client, raw.library);
                if (error || !library) return error!;
                const createdPath = await client.createFolder(library.id, path);
                return ok({
                    library,
                    path: createdPath,
                    message: `已在「${library.name}」创建文件夹 ${createdPath}`,
                });
            } catch (error) {
                if (error instanceof ThuError) return fail(error.code, error.message);
                throw error;
            }
        },
    };
}
