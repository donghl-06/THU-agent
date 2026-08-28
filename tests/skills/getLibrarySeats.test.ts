/**
 * get_library_seats Skill 独立测试（假数据，无网络）。
 */
import {describe, expect, it} from "vitest";
import {createGetLibrarySeatsSkill, type LibrarySeatsData} from "../../src/skills/library/getLibrarySeats";

const base = {enName: "", enNameTrace: "", valid: true};
const fakeClient = {
    getLibraryList: async () => [
        {id: 1, zhName: "总馆", zhNameTrace: "总馆", ...base},
        {id: 2, zhName: "文科馆", zhNameTrace: "文科馆", ...base},
        {id: 99, zhName: "无效馆", zhNameTrace: "无效馆", ...base, valid: false},
    ],
    getLibraryFloorList: async (lib: {id: number}) =>
        lib.id === 1
            ? [{id: 11, zhName: "二层", zhNameTrace: "总馆 - 二层", ...base}]
            : [{id: 21, zhName: "三层", zhNameTrace: "文科馆 - 三层", ...base}],
    getLibrarySectionList: async (floor: {id: number}) =>
        floor.id === 11
            ? [
                {id: 111, zhName: "A 区", zhNameTrace: "总馆 - 二层 - A 区", total: 100, available: 30, posX: 0, posY: 0, ...base},
                {id: 112, zhName: "B 区", zhNameTrace: "总馆 - 二层 - B 区", total: 80, available: 0, posX: 0, posY: 0, ...base},
            ]
            : [
                {id: 211, zhName: "C 区", zhNameTrace: "文科馆 - 三层 - C 区", total: 60, available: 12, posX: 0, posY: 0, ...base},
            ],
};

const skill = createGetLibrarySeatsSkill(fakeClient as never);
const exec = async (input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: LibrarySeatsData; error?: {code: string; message: string}};

describe("get_library_seats Skill（假数据，无网络）", () => {
    it("三层钻取合并成扁平空位表，按空位降序", async () => {
        const r = await exec({});
        expect(r.success).toBe(true);
        expect(r.data!.day).toBe("today");
        expect(r.data!.sections.map((s) => [s.section, s.available])).toEqual([
            ["A 区", 30],
            ["C 区", 12],
            ["B 区", 0],
        ]);
        expect(r.data!.sections[0].library).toBe("总馆");
        expect(r.data!.sections[0].floor).toBe("二层");
        expect(r.data!.totalAvailable).toBe(42);
    });

    it("library 关键词过滤", async () => {
        const r = await exec({library: "文科馆"});
        expect(r.data!.sections).toHaveLength(1);
        expect(r.data!.sections[0].library).toBe("文科馆");
    });

    it("找不到馆时报错", async () => {
        const r = await exec({library: "不存在的馆"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
    });

    it("非法 day 参数被拒绝", async () => {
        expect((await exec({day: "后天"})).success).toBe(false);
    });
});
