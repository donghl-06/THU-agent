/**
 * get_schedule Skill 独立测试（plan4ai.md 第 9 节）。
 *
 * 本文件不依赖网络、不依赖 DeepSeek/Harness：
 * 通过注入假的 ScheduleSource 验证 Skill 的输入校验与日期过滤逻辑。
 * （真实链路验证见 tests/integration/ 下的集成测试。）
 */
import {describe, expect, it} from "vitest";
import {ScheduleType, type Schedule} from "@thu-info/lib/dist/models/schedule/schedule";
import type {CalendarData} from "@thu-info/lib/dist/models/schedule/calendar";
import {createGetScheduleSkill, type ScheduleData} from "../../src/skills/schedule/getSchedule";

// 构造一个学期：2026-09-14（周一）开学，共 16 周
const fakeCalendar: CalendarData = {
    firstDay: "2026-09-14",
    semesterId: "2026-2027-1",
    semesterName: "2026-2027秋季学期",
    weekCount: 16,
    nextSemesterList: [],
};

const makeCourse = (
    name: string,
    location: string,
    dayOfWeek: number,
    begin: number,
    end: number,
    activeWeeks: number[],
): Schedule => ({
    name,
    location,
    hash: `${name}@${location}`,
    type: ScheduleType.PRIMARY,
    activeTime: {base: [{dayOfWeek, begin, end, activeWeeks}]},
    delOrHideTime: {base: []},
});

const fakeSchedule: Schedule[] = [
    makeCourse("数据结构", "六教6A214", 1, 1, 2, [1, 2, 3, 4, 5]), // 周一 1-2 节，1-5 周
    makeCourse("数据结构", "六教6A214", 3, 3, 4, [1, 2, 3, 4, 5]), // 同课周三 3-4 节
    makeCourse("大学物理", "一教104", 1, 6, 7, [2, 4]),           // 周一 6-7 节，仅 2、4 周
];

const fakeClient = {
    getSchedule: async () => ({schedule: fakeSchedule, calendar: fakeCalendar}),
};

const skill = createGetScheduleSkill(fakeClient);

const exec = async (input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: ScheduleData; error?: {code: string}};

describe("get_schedule Skill（假数据，无网络）", () => {
    it("能按日期过滤出当天课程", async () => {
        // 2026-09-14 是开学第一天（周一，第 1 周）
        const r = await exec({date: "2026-09-14"});
        expect(r.success).toBe(true);
        expect(r.data!.weekNumber).toBe(1);
        expect(r.data!.dayOfWeek).toBe(1);
        expect(r.data!.courses.map((c) => c.name)).toEqual(["数据结构"]);
        // 大学物理第 1 周不上（仅 2、4 周）
        expect(r.data!.courses.some((c) => c.name === "大学物理")).toBe(false);
    });

    it("同一门课的不同上课时间互不干扰", async () => {
        // 2026-09-16 周三，第 1 周
        const r = await exec({date: "2026-09-16"});
        expect(r.data!.courses).toHaveLength(1);
        expect(r.data!.courses[0]).toMatchObject({
            name: "数据结构",
            beginSession: 3,
            endSession: 4,
            location: "六教6A214",
        });
    });

    it("按活跃周正确过滤", async () => {
        // 2026-09-28 周一，第 3 周：大学物理不在活跃周
        let r = await exec({date: "2026-09-28"});
        expect(r.data!.courses.map((c) => c.name)).toEqual(["数据结构"]);
        // 2026-09-21 周一，第 2 周：两门都有，按节次排序
        r = await exec({date: "2026-09-21"});
        expect(r.data!.courses.map((c) => c.name)).toEqual(["数据结构", "大学物理"]);
    });

    it("日期在学期外时返回空课表和说明", async () => {
        const r = await exec({date: "2026-09-07"}); // 开学前一周
        expect(r.success).toBe(true);
        expect(r.data!.courses).toHaveLength(0);
        expect(r.data!.weekNumber).toBeNull();
        expect(r.data!.note).toContain("不在");
    });

    it("拒绝非法日期格式", async () => {
        for (const bad of ["2026/09/14", "明天", "2026-13-01", "2026-02-30", 42]) {
            const r = await exec({date: bad});
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
    });

    it("省略 date 时默认查今天", async () => {
        const r = await exec();
        expect(r.success).toBe(true);
        expect(r.data!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});
