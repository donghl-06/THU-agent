/**
 * Skill: transfer_cloud_item —— 复制或移动云盘文件/文件夹。
 * 移动会改变原路径，复制会新增路径，都必须先确认。
 */
import type {CloudDirent, CloudLibrary} from "../../client/cloud/CloudClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {
    cloudBasename,
    cloudParentDir,
    normalizeCloudPath,
    resolveCloudDirent,
    resolveCloudLibrary,
} from "./cloudResolve";

type CloudTransferSource = {
    listLibraries: () => Promise<CloudLibrary[]>;
    getDirectory: (repoId: string, path: string) => Promise<CloudDirent[]>;
    transferDirent: (
        repoId: string,
        sourceParentDir: string,
        name: string,
        destinationRepoId: string,
        destinationDir: string,
        operation: "copy" | "move",
    ) => Promise<unknown>;
};

export interface TransferCloudItemData {
    operation: "copy" | "move";
    sourceLibrary: CloudLibrary;
    sourcePath: string;
    destinationLibrary: CloudLibrary;
    destinationPath: string;
    type: CloudDirent["type"];
    message: string;
}

function transferredName(result: unknown, fallback: string): string {
    const first = Array.isArray(result) ? result[0] as {obj_name?: unknown} | undefined : undefined;
    return typeof first?.obj_name === "string" && first.obj_name.trim() ? first.obj_name : fallback;
}

export function createTransferCloudItemSkill(client: CloudTransferSource): Skill {
    return {
        name: "transfer_cloud_item",
        description:
            "复制或移动清华云盘中的文件/文件夹（真实写操作，需确认）。" +
            "operation 填 copy 或 move；destinationLibrary 省略时表示在同一个资料库内操作。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                operation: {type: "string", enum: ["copy", "move"], description: "copy=复制，move=移动"},
                library: {type: "string", description: "源资料库 ID 或唯一名称"},
                path: {type: "string", description: "源文件/文件夹完整路径"},
                destinationLibrary: {type: "string", description: "目标资料库，默认同源资料库"},
                destinationFolder: {type: "string", description: "目标目录，默认 /"},
            },
            required: ["operation", "library", "path"],
        },

        async execute(input: unknown): Promise<SkillResult<TransferCloudItemData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (raw.operation !== "copy" && raw.operation !== "move") {
                return fail("INVALID_INPUT", "operation 只能是 copy 或 move");
            }
            if (typeof raw.library !== "string" || !raw.library.trim()) {
                return fail("INVALID_INPUT", "library 必填且必须是非空字符串");
            }
            const sourcePath = normalizeCloudPath(raw.path);
            if (typeof raw.path !== "string" || sourcePath === undefined || sourcePath === "/") {
                return fail("INVALID_INPUT", "path 必须是有效的非根目录路径");
            }
            if (raw.destinationLibrary !== undefined && typeof raw.destinationLibrary !== "string") {
                return fail("INVALID_INPUT", "destinationLibrary 必须是字符串");
            }
            const destinationDir = normalizeCloudPath(raw.destinationFolder ?? "/");
            if (destinationDir === undefined) {
                return fail("INVALID_INPUT", "destinationFolder 不能包含 . 或 .. 路径段");
            }

            try {
                const source = await resolveCloudDirent(client, raw.library, sourcePath);
                if (source.error || !source.library || !source.entry) return source.error!;

                let destinationLibrary = source.library;
                if (raw.destinationLibrary !== undefined) {
                    const destination = await resolveCloudLibrary(client, raw.destinationLibrary);
                    if (destination.error || !destination.library) return destination.error!;
                    destinationLibrary = destination.library;
                }
                await client.getDirectory(destinationLibrary.id, destinationDir);
                if (destinationLibrary.id === source.library!.id &&
                    cloudParentDir(sourcePath) === destinationDir) {
                    return fail("INVALID_INPUT", "目标目录与源目录相同，无需复制或移动");
                }
                if (destinationLibrary.id === source.library!.id && (
                    destinationDir === sourcePath || destinationDir.startsWith(`${sourcePath}/`)
                )) {
                    return fail("INVALID_INPUT", "不能把文件夹复制或移动到自身或它的子目录中");
                }
                if (cloudBasename(sourcePath).includes(":")) {
                    return fail(
                        "INVALID_INPUT",
                        "暂不支持复制或移动名称包含英文冒号“:”的云盘项目，请先重命名后再操作",
                    );
                }

                const result = await client.transferDirent(
                    source.library!.id,
                    cloudParentDir(sourcePath),
                    cloudBasename(sourcePath),
                    destinationLibrary.id,
                    destinationDir,
                    raw.operation,
                );
                const name = transferredName(result, cloudBasename(sourcePath));
                const destinationPath = `${destinationDir === "/" ? "" : destinationDir}/${name}`;
                return ok({
                    operation: raw.operation,
                    sourceLibrary: source.library,
                    sourcePath,
                    destinationLibrary,
                    destinationPath,
                    type: source.entry.type,
                    message: raw.operation === "copy"
                        ? `已复制「${source.library.name}${sourcePath}」到「${destinationLibrary.name}${destinationPath}」`
                        : `已移动「${source.library.name}${sourcePath}」到「${destinationLibrary.name}${destinationPath}」`,
                });
            } catch (error) {
                if (error instanceof ThuError) return fail(error.code, error.message);
                throw error;
            }
        },
    };
}
