/**
 * Skill: search_cloud_files —— 在清华云盘全局搜索文件。
 *
 * 只返回文件元数据，不返回下载链接或 API Token，避免敏感凭证进入对话。
 */
import type {CloudSearchResult} from "../../client/cloud/CloudClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

const MAX_LIMIT = 50;

type CloudSearchSource = {
    searchFiles: (keyword: string) => Promise<CloudSearchResult[]>;
};

export interface CloudSearchData {
    keyword: string;
    total: number;
    truncated: boolean;
    results: CloudSearchResult[];
}

export function createSearchCloudFilesSkill(client: CloudSearchSource): Skill {
    return {
        name: "search_cloud_files",
        description:
            "在当前账号的清华云盘中全局搜索文件。用户问“云盘里有没有xx课件/报告/照片”时使用。" +
            "返回路径和所属资料库；要看所在文件夹可继续调用 get_cloud_directory。",
        inputSchema: {
            type: "object",
            properties: {
                keyword: {
                    type: "string",
                    description: "文件名关键词，如“数据结构”“开题报告”",
                },
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: MAX_LIMIT,
                    description: `返回条数上限，默认 20，最大 ${MAX_LIMIT}`,
                },
            },
            required: ["keyword"],
        },

        async execute(input: unknown): Promise<SkillResult<CloudSearchData>> {
            const raw = (input ?? {}) as {keyword?: unknown; limit?: unknown};
            if (typeof raw.keyword !== "string" || !raw.keyword.trim()) {
                return fail("INVALID_INPUT", "keyword 必填且必须是非空字符串");
            }
            if (raw.keyword.trim().length > 100) {
                return fail("INVALID_INPUT", "keyword 过长，请控制在 100 个字符以内");
            }
            if (raw.limit !== undefined && (
                typeof raw.limit !== "number" ||
                !Number.isInteger(raw.limit) ||
                raw.limit < 1 ||
                raw.limit > MAX_LIMIT
            )) {
                return fail("INVALID_INPUT", `limit 必须是 1-${MAX_LIMIT} 之间的整数`);
            }

            const keyword = raw.keyword.trim();
            const limit = typeof raw.limit === "number" ? raw.limit : 20;
            try {
                const results = await client.searchFiles(keyword);
                return ok({
                    keyword,
                    total: results.length,
                    truncated: results.length > limit,
                    results: results.slice(0, limit),
                });
            } catch (error) {
                if (error instanceof ThuError) return fail(error.code, error.message);
                throw error;
            }
        },
    };
}
