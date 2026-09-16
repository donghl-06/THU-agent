/**
 * Skill: create_cloud_share_link —— 为云盘文件或文件夹生成分享链接。
 *
 * 分享会把原本私有的云盘内容公开为可访问链接，因此必须先由用户确认
 * 「资料库、对象路径、有效期」。第一版只创建只读下载链接，不设置密码、
 * 不开放编辑或上传权限。
 */
import type {CloudDirent, CloudLibrary, CloudShareLink} from "../../client/cloud/CloudClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {normalizeCloudPath, resolveCloudDirent} from "./cloudResolve";

type CloudShareLinkSource = {
    listLibraries: () => Promise<CloudLibrary[]>;
    getDirectory: (repoId: string, path: string) => Promise<CloudDirent[]>;
    createShareLink: (
        repoId: string,
        path: string,
        options?: {expireDays?: number},
    ) => Promise<CloudShareLink>;
};

export interface CreateCloudShareLinkData {
    library: CloudLibrary;
    shareLink: CloudShareLink;
    type: CloudDirent["type"];
    message: string;
}

export function createCloudShareLinkSkill(client: CloudShareLinkSource): Skill {
    return {
        name: "create_cloud_share_link",
        description:
            "为清华云盘中的文件或文件夹生成只读分享链接（公开化操作，需确认）。" +
            "使用前必须向用户复述资料库、完整路径和有效期；expireDays 可选，表示有效天数。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                library: {type: "string", description: "资料库 ID 或唯一名称"},
                path: {type: "string", description: "要分享的文件或文件夹完整路径，不能是根目录 /"},
                expireDays: {
                    type: "integer",
                    minimum: 1,
                    description: "分享链接有效天数；不传时遵循云盘默认策略（通常永久有效）",
                },
            },
            required: ["library", "path"],
        },

        async execute(input: unknown): Promise<SkillResult<CreateCloudShareLinkData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.library !== "string" || !raw.library.trim()) {
                return fail("INVALID_INPUT", "library 必填且必须是非空字符串");
            }
            const path = normalizeCloudPath(raw.path);
            if (typeof raw.path !== "string" || path === undefined || path === "/") {
                return fail("INVALID_INPUT", "path 必须是有效的非根目录路径，且不能包含 . 或 ..");
            }
            if (raw.expireDays !== undefined &&
                (typeof raw.expireDays !== "number" || !Number.isInteger(raw.expireDays) || raw.expireDays < 1)) {
                return fail("INVALID_INPUT", "expireDays 必须是不小于 1 的整数");
            }

            try {
                const {library, entry, error} = await resolveCloudDirent(client, raw.library, path);
                if (error || !library || !entry) return error!;
                const shareLink = await client.createShareLink(
                    library.id,
                    path,
                    raw.expireDays === undefined ? undefined : {expireDays: raw.expireDays},
                );
                const typeName = entry.type === "dir" ? "文件夹" : "文件";
                return ok({
                    library,
                    shareLink,
                    type: entry.type,
                    message: `已生成${typeName}「${library.name}${path}」的分享链接：${shareLink.url}`,
                });
            } catch (error) {
                if (error instanceof ThuError) return fail(error.code, error.message);
                throw error;
            }
        },
    };
}
