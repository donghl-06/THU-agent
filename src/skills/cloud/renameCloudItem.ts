/**
 * Skill: rename_cloud_item —— 重命名云盘文件或文件夹（真实写操作，需确认）。
 */
import type {CloudDirent, CloudLibrary} from "../../client/cloud/CloudClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {normalizeCloudPath, resolveCloudDirent, validCloudName} from "./cloudResolve";

type CloudRenameSource = {
    listLibraries: () => Promise<CloudLibrary[]>;
    getDirectory: (repoId: string, path: string) => Promise<CloudDirent[]>;
    renameDirent: (
        repoId: string,
        path: string,
        type: CloudDirent["type"],
        newName: string,
    ) => Promise<string>;
};

export interface RenameCloudItemData {
    library: CloudLibrary;
    oldPath: string;
    newPath: string;
    type: CloudDirent["type"];
    message: string;
}

export function createRenameCloudItemSkill(client: CloudRenameSource): Skill {
    return {
        name: "rename_cloud_item",
        description:
            "重命名清华云盘中的文件或文件夹（真实写操作，需确认）。" +
            "path 必须是当前完整路径；newName 只是文件名，不能包含 / 或 \\。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                library: {type: "string", description: "资料库 ID 或唯一名称"},
                path: {type: "string", description: "当前完整路径"},
                newName: {type: "string", description: "新文件名或文件夹名"},
            },
            required: ["library", "path", "newName"],
        },

        async execute(input: unknown): Promise<SkillResult<RenameCloudItemData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.library !== "string" || !raw.library.trim()) {
                return fail("INVALID_INPUT", "library 必填且必须是非空字符串");
            }
            const path = normalizeCloudPath(raw.path);
            if (typeof raw.path !== "string" || path === undefined || path === "/") {
                return fail("INVALID_INPUT", "path 必须是有效的非根目录路径");
            }
            if (!validCloudName(raw.newName)) {
                return fail("INVALID_INPUT", "newName 不能包含路径分隔符或 Windows 保留字符");
            }

            try {
                const {library, entry, error} = await resolveCloudDirent(client, raw.library, path);
                if (error || !library || !entry) return error!;
                const newPath = await client.renameDirent(
                    library.id,
                    path,
                    entry.type,
                    String(raw.newName).trim(),
                );
                return ok({
                    library,
                    oldPath: path,
                    newPath,
                    type: entry.type,
                    message: `已将「${library.name}${path}」重命名为 ${newPath}`,
                });
            } catch (error) {
                if (error instanceof ThuError) return fail(error.code, error.message);
                throw error;
            }
        },
    };
}
