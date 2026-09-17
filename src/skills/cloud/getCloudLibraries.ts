/**
 * Skill: get_cloud_libraries —— 查询清华云盘资料库列表。
 *
 * 登录复用清华统一身份认证账号；返回资料库 ID 供后续目录查询使用。
 * 本技能只读，不创建、删除或修改云盘资料库。
 */
import type {CloudLibrary} from "../../client/cloud/CloudClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

const MAX_ITEMS = 100;

type CloudLibrarySource = {
    listLibraries: () => Promise<CloudLibrary[]>;
};

export interface CloudLibrariesData {
    total: number;
    truncated: boolean;
    libraries: CloudLibrary[];
}

export function createGetCloudLibrariesSkill(client: CloudLibrarySource): Skill {
    return {
        name: "get_cloud_libraries",
        description:
            "查询当前清华账号在清华云盘（cloud.tsinghua.edu.cn）中的资料库列表。" +
            "用户问“我云盘里有哪些库/文件夹/资料库”或后续要浏览云盘时先调用。" +
            "返回的 id 必须原样传给 get_cloud_directory。",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },

        async execute(): Promise<SkillResult<CloudLibrariesData>> {
            try {
                const libraries = await client.listLibraries();
                return ok({
                    total: libraries.length,
                    truncated: libraries.length > MAX_ITEMS,
                    libraries: libraries.slice(0, MAX_ITEMS),
                });
            } catch (error) {
                if (error instanceof ThuError) return fail(error.code, error.message);
                throw error;
            }
        },
    };
}
