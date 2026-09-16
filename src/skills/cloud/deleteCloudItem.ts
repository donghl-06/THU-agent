/**
 * Skill: delete_cloud_item —— 删除云盘文件/文件夹。
 * Seafile 会进入回收站，但删除仍是高危写操作，必须先确认。
 */
import type {CloudDirent, CloudLibrary} from "../../client/cloud/CloudClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {normalizeCloudPath, resolveCloudDirent} from "./cloudResolve";

type CloudDeleteSource = {
    listLibraries: () => Promise<CloudLibrary[]>;
    getDirectory: (repoId: string, path: string) => Promise<CloudDirent[]>;
    deleteDirent: (repoId: string, path: string, type: CloudDirent["type"]) => Promise<void>;
};

export interface DeleteCloudItemData {
    library: CloudLibrary;
    path: string;
    type: CloudDirent["type"];
    message: string;
}

export function createDeleteCloudItemSkill(client: CloudDeleteSource): Skill {
    return {
        name: "delete_cloud_item",
        description:
            "删除清华云盘中的文件或文件夹（高危写操作，需确认）。" +
            "path 必须是完整路径；删除后通常进入云盘网页端回收站，但清灵暂不支持直接恢复。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                library: {type: "string", description: "资料库 ID 或唯一名称"},
                path: {type: "string", description: "要删除的完整路径，不能是 /"},
            },
            required: ["library", "path"],
        },

        async execute(input: unknown): Promise<SkillResult<DeleteCloudItemData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.library !== "string" || !raw.library.trim()) {
                return fail("INVALID_INPUT", "library 必填且必须是非空字符串");
            }
            const path = normalizeCloudPath(raw.path);
            if (typeof raw.path !== "string" || path === undefined || path === "/") {
                return fail("INVALID_INPUT", "path 必须是有效的非根目录路径");
            }

            try {
                const {library, entry, error} = await resolveCloudDirent(client, raw.library, path);
                if (error || !library || !entry) return error!;
                await client.deleteDirent(library.id, path, entry.type);
                return ok({
                    library,
                    path,
                    type: entry.type,
                    message: `已删除「${library.name}${path}」。如需恢复请尽快到清华云盘网页端回收站查找。`,
                });
            } catch (error) {
                if (error instanceof ThuError) return fail(error.code, error.message);
                throw error;
            }
        },
    };
}
