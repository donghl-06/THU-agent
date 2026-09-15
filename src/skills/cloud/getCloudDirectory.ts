/**
 * Skill: get_cloud_directory —— 浏览清华云盘某个资料库内的目录。
 *
 * library 支持资料库 ID 或名称；名称必须唯一匹配。path 只读浏览，
 * 不做上传/下载/删除等真实文件操作。
 */
import type {CloudDirent, CloudLibrary} from "../../client/cloud/CloudClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

const MAX_ENTRIES = 200;

type CloudDirectorySource = {
    listLibraries: () => Promise<CloudLibrary[]>;
    getDirectory: (repoId: string, path: string) => Promise<CloudDirent[]>;
};

export interface CloudDirectoryData {
    library: CloudLibrary;
    path: string;
    total: number;
    truncated: boolean;
    entries: CloudDirent[];
}

function normalizeCloudPath(input: unknown): string | undefined {
    if (typeof input !== "string") return undefined;
    const withSlash = input.trim().startsWith("/") ? input.trim() : `/${input.trim()}`;
    const parts = withSlash.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) return undefined;
    return `/${parts.join("/")}`;
}

export function createGetCloudDirectorySkill(client: CloudDirectorySource): Skill {
    return {
        name: "get_cloud_directory",
        description:
            "浏览清华云盘某个资料库下的一层目录，返回文件和子文件夹。" +
            "library 可以填 get_cloud_libraries 返回的 id，也可以填唯一资料库名；" +
            "path 默认根目录 /。用户说“看看我的xx资料库/云盘里的课件目录”时使用。",
        inputSchema: {
            type: "object",
            properties: {
                library: {
                    type: "string",
                    description: "资料库 ID 或资料库名称，如“学习资料”或 get_cloud_libraries 返回的 id",
                },
                path: {
                    type: "string",
                    description: "资料库内路径，默认 /。例如 /课件/大三上",
                },
            },
            required: ["library"],
        },

        async execute(input: unknown): Promise<SkillResult<CloudDirectoryData>> {
            const raw = (input ?? {}) as {library?: unknown; path?: unknown};
            if (typeof raw.library !== "string" || !raw.library.trim()) {
                return fail("INVALID_INPUT", "library 必填且必须是非空字符串（资料库 ID 或名称）");
            }
            if (raw.path !== undefined && typeof raw.path !== "string") {
                return fail("INVALID_INPUT", "path 必须是字符串");
            }
            const path = normalizeCloudPath(raw.path ?? "/");
            if (path === undefined) return fail("INVALID_INPUT", "path 不能包含 . 或 .. 路径段");

            const keyword = raw.library.trim();
            try {
                const libraries = await client.listLibraries();
                const exactId = libraries.filter((item) => item.id === keyword);
                const matched = exactId.length > 0 ? exactId : libraries.filter((item) =>
                    item.name.toLowerCase() === keyword.toLowerCase()
                );
                if (matched.length === 0) {
                    return fail(
                        "NOT_FOUND",
                        `清华云盘中没有名为「${keyword}」的资料库。请先调用 get_cloud_libraries 查看可用资料库。`,
                    );
                }
                if (matched.length > 1) {
                    return fail(
                        "AMBIGUOUS",
                        `「${keyword}」匹配到 ${matched.length} 个云盘资料库：` +
                        matched.slice(0, 10).map((item) => item.name).join("、") +
                        "。请使用资料库 ID 或更完整的名称。",
                    );
                }

                const entries = await client.getDirectory(matched[0].id, path);
                return ok({
                    library: matched[0],
                    path,
                    total: entries.length,
                    truncated: entries.length > MAX_ENTRIES,
                    entries: entries.slice(0, MAX_ENTRIES),
                });
            } catch (error) {
                if (error instanceof ThuError) {
                    if (error.code === "UPSTREAM_ERROR" && error.message.includes("404")) {
                        return fail("NOT_FOUND", `云盘路径不存在或无权访问：${path}`);
                    }
                    return fail(error.code, error.message);
                }
                throw error;
            }
        },
    };
}
