/**
 * Skill: get_library_seats —— 查询图书馆各区域的座位空余情况。
 *
 * 库的数据层级：馆 → 楼层 → 区域（区域级就有 总数/空位数）。
 * 本 Skill 把三层钻取合并成一张扁平的空位表，模型无需关心层级。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface LibrarySectionAvailability {
    /** 馆名（如"北馆"） */
    library: string;
    /** 楼层名 */
    floor: string;
    /** 区域名 */
    section: string;
    total: number;
    available: number;
}

export interface LibrarySeatsData {
    /** today / tomorrow */
    day: string;
    sections: LibrarySectionAvailability[];
    totalAvailable: number;
}

type LibrarySource = Pick<ThuClient, "getLibraryList" | "getLibraryFloorList" | "getLibrarySectionList">;

export function createGetLibrarySeatsSkill(client: LibrarySource): Skill {
    return {
        name: "get_library_seats",
        description:
            "查询图书馆各区域今天或明天的座位空余情况（馆/楼层/区域、总座位数、空位数）。" +
            "可以用 library 参数只看某个馆（如“北馆”“文科”）。",
        inputSchema: {
            type: "object",
            properties: {
                day: {
                    type: "string",
                    enum: ["today", "tomorrow"],
                    description: "查询今天还是明天，默认 today",
                },
                library: {
                    type: "string",
                    description: "可选，馆名关键词过滤（如“北馆”）",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<LibrarySeatsData>> {
            const raw = (input ?? {}) as {day?: unknown; library?: unknown};
            if (raw.day !== undefined && raw.day !== "today" && raw.day !== "tomorrow") {
                return fail("INVALID_INPUT", "day 只能是 \"today\" 或 \"tomorrow\"");
            }
            if (raw.library !== undefined && typeof raw.library !== "string") {
                return fail("INVALID_INPUT", "library 必须是字符串");
            }
            const day = (raw.day as "today" | "tomorrow" | undefined) ?? "today";
            const dateChoice: 0 | 1 = day === "today" ? 0 : 1;

            try {
                let libraries = (await client.getLibraryList()).filter((l) => l.valid);
                if (typeof raw.library === "string" && raw.library.trim() !== "") {
                    const kw = raw.library.trim();
                    libraries = libraries.filter((l) => l.zhName.includes(kw));
                    if (libraries.length === 0) {
                        return fail("INVALID_INPUT", `找不到名称包含“${kw}”的图书馆`);
                    }
                }

                // 馆 → 楼层 → 区域，逐层展开（层内并行）
                const floorsByLibrary = await Promise.all(
                    libraries.map((lib) => client.getLibraryFloorList(lib, dateChoice)),
                );
                const floors = floorsByLibrary.flat().filter((f) => f.valid);
                const sectionsByFloor = await Promise.all(
                    floors.map((floor) => client.getLibrarySectionList(floor, dateChoice)),
                );

                const sections: LibrarySectionAvailability[] = sectionsByFloor
                    .flat()
                    .filter((s) => s.valid)
                    .map((s) => ({
                        library: s.zhNameTrace.split(" - ")[0] ?? s.zhNameTrace,
                        floor: s.zhNameTrace.split(" - ")[1] ?? "",
                        section: s.zhName,
                        total: s.total,
                        available: s.available,
                    }))
                    .sort((a, b) => b.available - a.available);

                return ok({
                    day,
                    sections,
                    totalAvailable: sections.reduce((sum, s) => sum + s.available, 0),
                });
            } catch (e) {
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e;
            }
        },
    };
}
