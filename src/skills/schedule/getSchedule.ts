/**
 * Skill: get_schedule —— 查询指定日期（默认今天）的课程安排。
 *
 * 职责（plan4ai.md 第 4 节）：校验输入 → 调 ThuClient → 规范化输出。
 * 不包含任何 LLM 推理，可脱离 Harness 独立执行和测试。
 *
 * 库的 getSchedule() 返回整学期课表（课程块 + 活跃周），
 * 本 Skill 负责按日期换算周次并过滤出当天课程。
 * 星期约定（来自库源码 parseJSON）：周一=1 …… 周日=7。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {dayOfWeekOf, formatDate, parseDate, weekNumberOf} from "../base/dateUtils";

export interface ScheduleCourse {
    name: string;
    location: string;
    /** 起始节次，如第 3 节 */
    beginSession: number;
    /** 结束节次（含），如第 5 节 */
    endSession: number;
}

export interface ScheduleData {
    /** 查询日期，YYYY-MM-DD */
    date: string;
    /** 周一=1 …… 周日=7 */
    dayOfWeek: number;
    /** 本学期第几周；日期不在学期内时为 null */
    weekNumber: number | null;
    semesterName: string;
    courses: ScheduleCourse[];
    /** 给模型看的补充说明（如"该日期不在本学期范围内"） */
    note?: string;
}

/** 只依赖 ThuClient 的 getSchedule，方便测试时注入假实现 */
type ScheduleSource = Pick<ThuClient, "getSchedule">;

export function createGetScheduleSkill(client: ScheduleSource): Skill {
    return {
        name: "get_schedule",
        description:
            "查询指定日期（默认今天）的课程安排，返回当天课程列表" +
            "（课程名、上课节次、地点）以及该日期对应的学期周次。",
        inputSchema: {
            type: "object",
            properties: {
                date: {
                    type: "string",
                    description: "要查询的日期，格式 YYYY-MM-DD；省略时表示今天",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<ScheduleData>> {
            // 1. 校验输入
            const raw = (input ?? {}) as {date?: unknown};
            if (raw.date !== undefined && typeof raw.date !== "string") {
                return fail("INVALID_INPUT", "date 必须是 YYYY-MM-DD 格式的字符串");
            }
            const target = raw.date === undefined
                ? new Date()
                : parseDate(raw.date as string);
            if (target === null) {
                return fail("INVALID_INPUT", `无法解析日期：${raw.date}，请使用 YYYY-MM-DD 格式`);
            }

            // 2. 调 ThuClient
            let scheduleData;
            try {
                scheduleData = await client.getSchedule();
            } catch (e) {
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e; // 理论上 ThuClient 已归一化，防御性抛出
            }

            // 3. 规范化输出：按日期过滤当天课程
            const {schedule, calendar} = scheduleData;
            const dayOfWeek = dayOfWeekOf(target);
            const firstDay = parseDate(calendar.firstDay);
            if (firstDay === null) {
                return fail("UPSTREAM_ERROR", `无法解析学期开学日期：${calendar.firstDay}`);
            }
            const weekNumber = weekNumberOf(firstDay, target);

            const base: ScheduleData = {
                date: formatDate(target),
                dayOfWeek,
                weekNumber: null,
                semesterName: calendar.semesterName,
                courses: [],
            };

            if (weekNumber < 1 || weekNumber > calendar.weekCount) {
                return ok({
                    ...base,
                    note: `${formatDate(target)} 不在 ${calendar.semesterName} 范围内` +
                        `（${calendar.firstDay} 起共 ${calendar.weekCount} 周）`,
                });
            }

            const courses: ScheduleCourse[] = [];
            for (const item of schedule) {
                for (const slice of item.activeTime.base) {
                    if (slice.dayOfWeek === dayOfWeek && slice.activeWeeks.includes(weekNumber)) {
                        courses.push({
                            name: item.name,
                            location: item.location,
                            beginSession: slice.begin,
                            endSession: slice.end,
                        });
                    }
                }
            }
            courses.sort((a, b) => a.beginSession - b.beginSession);

            return ok({...base, weekNumber, courses});
        },
    };
}
