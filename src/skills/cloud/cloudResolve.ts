import type {CloudDirent, CloudLibrary} from "../../client/cloud/CloudClient";
import {fail, type SkillResult} from "../base/types";

export function normalizeCloudPath(input: unknown): string | undefined {
    if (typeof input !== "string" || !input.trim()) return undefined;
    const withSlash = input.trim().startsWith("/") ? input.trim() : `/${input.trim()}`;
    const parts = withSlash.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === ".." || part === "")) return undefined;
    return `/${parts.join("/")}`.replace(/\/+$/, "") || "/";
}

export function cloudParentDir(path: string): string {
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 1) return "/";
    return `/${parts.slice(0, -1).join("/")}`;
}

export function cloudBasename(path: string): string {
    return path.split("/").filter(Boolean).pop() ?? "";
}

export function validCloudName(name: unknown): name is string {
    return typeof name === "string" &&
        name.trim().length > 0 &&
        name.trim().length <= 255 &&
        !/[\\/]/.test(name) &&
        !/^[. ]+$/.test(name) &&
        !/[<>:"|?*\u0000-\u001f]/.test(name);
}

export async function resolveCloudLibrary(
    client: {listLibraries: () => Promise<CloudLibrary[]>},
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

export async function resolveCloudDirent(
    client: {
        listLibraries: () => Promise<CloudLibrary[]>;
        getDirectory: (repoId: string, path: string) => Promise<CloudDirent[]>;
    },
    libraryKeyword: string,
    itemPath: string,
): Promise<{library?: CloudLibrary; entry?: CloudDirent; error?: SkillResult<never>}> {
    const {library, error} = await resolveCloudLibrary(client, libraryKeyword);
    if (error || !library) return {error};

    const name = cloudBasename(itemPath);
    const entries = await client.getDirectory(library.id, cloudParentDir(itemPath));
    const entry = entries.find((item) => item.name === name);
    if (!entry) {
        return {error: fail("NOT_FOUND", `云盘中不存在路径「${itemPath}」，请先用 get_cloud_directory 确认。`)};
    }
    return {library, entry};
}
