/**
 * get_classroom_state Skill 独立测试（假数据，无网络）。
 */
import {describe, expect, it} from "vitest";
import {ClassroomStatus} from "@thu-info/lib/dist/models/home/classroom";
import {createGetClassroomStateSkill, type ClassroomStateData} from "../../src/skills/classroom/getClassroomState";

const fakeCalendar = {
    firstDay: "2026-09-14",
    semesterId: "2026-2027-1",
    semesterName: "2026-2027秋季学期",
    weekCount: 16,
    nextSemesterList: [],
};

const fakeList = [
    {name: "六教", weekNumber: 1, searchName: "6"},
    {name: "三教", weekNumber: 1, searchName: "3"},
];

// 造 42 格状态：全占用，再挖几个空
const makeStatus = (availableAt: number[]): ClassroomStatus[] =>
    Array.from({length: 42}, (_, i) =>
        availableAt.includes(i) ? ClassroomStatus.AVAILABLE : ClassroomStatus.TEACHING);

const fakeClient = {
    getCalendar: async () => fakeCalendar,
    getClassroomList: async () => fakeList,
    getClassroomState: async () => ({
        validWeekNumbers: [1, 2],
        currentWeekNumber: 1,
        datesOfCurrentWeek: ["09-14", "09-15", "09-16", "09-17", "09-18", "09-19", "09-20"],
        classroomStates: [
            // 周一（索引 0-5）的第 3、5 时段空闲
            {name: "六教6A214:128", status: makeStatus([2, 4])},
            // 周二（索引 6-11）的第 1 时段空闲
            {name: "六教6B101:96", status: makeStatus([6])},
            // 全周无空闲
            {name: "六教6C300:64", status: makeStatus([])},
        ],
    }),
};

const skill = createGetClassroomStateSkill(fakeClient as never);
const exec = async (input: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: ClassroomStateData; error?: {code: string; message: string}};

describe("get_classroom_state Skill（假数据，无网络）", () => {
    it("按星期几切片，只返回有空闲时段的教室", async () => {
        // 2026-09-14 周一
        const r = await exec({building: "六教", date: "2026-09-14"});
        expect(r.success).toBe(true);
        expect(r.data!.weekNumber).toBe(1);
        expect(r.data!.totalRooms).toBe(3);
        expect(r.data!.rooms).toEqual([{name: "六教6A214", availableBlocks: [3, 5]}]);
    });

    it("周二只有另一间教室空闲", async () => {
        const r = await exec({building: "六教", date: "2026-09-15"});
        expect(r.data!.rooms).toEqual([{name: "六教6B101", availableBlocks: [1]}]);
    });

    it("教学楼名不存在时返回可选列表", async () => {
        const r = await exec({building: "不存在的楼"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("六教");
    });

    it("缺 building 或日期非法时被拒绝", async () => {
        expect((await exec({})).success).toBe(false);
        expect((await exec({building: "六教", date: "2026/09/14"})).success).toBe(false);
    });

    it("学期外日期返回空结果和说明", async () => {
        const r = await exec({building: "六教", date: "2026-09-07"});
        expect(r.success).toBe(true);
        expect(r.data!.rooms).toHaveLength(0);
        expect(r.data!.note).toContain("不在");
    });
});
