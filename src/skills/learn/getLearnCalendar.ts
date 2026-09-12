/**
 * Skill: get_learn_calendar —— 网络学堂日历 + 作业截止时间聚合。
 *
 * 返回两部分：
 *   events            学堂日历事件（上课/考试安排，来自教务日历）
 *   homeworkDeadlines 窗口内截止的作业（「最近有什么要交」的日历视角）
 *
 * 上游限制：查询窗口不能超过 29 天。默认窗口是今天起 14 天（北京时间）。
 */
import {ThuError} from "../../client/errors";
import type {LearnClient} from "../../client/learn/LearnClient";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {courseDisplayName, type CourseSource} from "./courseResolve";
import {beijingDateString, formatBeijing} from "./format";

/** 上游 getCalendar 的窗口上限（天） */
const MAX_WINDOW_DAYS = 29;
const DEFAULT_WINDOW_DAYS = 14;

export interface LearnCalendarData {
    startDate: string;
    endDate: string;
    events: {
        date: string;
        courseName: string;
        startTime: string;
        endTime: string;
        location: string;
        status: string;
    }[];
    homeworkDeadlines: {
        course: string;
        title: string;
        deadline: string;
        status: "unsubmitted" | "submitted" | "graded";
    }[];
}

type CalendarSource = CourseSource & Pick<LearnClient, "getCalendar" | "getHomeworkList">;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD → 天数差（按 UTC 日界，够用于窗口校验） */
function daysBetween(start: string, end: string): number {
    return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / (24 * 3600 * 1000));
}

export function createGetLearnCalendarSkill(client: CalendarSource): Skill {
    return {
        name: "get_learn_calendar",
        description:
            "查询网络学堂（learn.tsinghua.edu.cn）日历：学堂日历事件（上课/考试安排）加上窗口内截止的作业清单。" +
            "startDate/endDate 形如 2026-09-13，窗口最长 29 天；省略时默认今天起 14 天（北京时间）。" +
            "问「最近有什么作业要交」「这两周有什么安排」用这个。",
        inputSchema: {
            type: "object",
            properties: {
                startDate: {
                    type: "string",
                    description: "可选，开始日期 YYYY-MM-DD（含），默认今天（北京时间）",
                },
                endDate: {
                    type: "string",
                    description: "可选，结束日期 YYYY-MM-DD（含），默认开始日期后 13 天；与 startDate 间隔不能超过 29 天",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<LearnCalendarData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            for (const k of ["startDate", "endDate"] as const) {
                if (raw[k] !== undefined && (typeof raw[k] !== "string" || !DATE_PATTERN.test(raw[k] as string))) {
                    return fail("INVALID_INPUT", `${k} 必须是 YYYY-MM-DD 格式，如 2026-09-13`);
                }
            }
            const startDate = (raw.startDate as string | undefined) ?? beijingDateString();
            const endDate = (raw.endDate as string | undefined) ?? beijingDateString(DEFAULT_WINDOW_DAYS - 1);
            if (daysBetween(startDate, endDate) < 0) {
                return fail("INVALID_INPUT", "endDate 不能早于 startDate");
            }
            if (daysBetween(startDate, endDate) >= MAX_WINDOW_DAYS) {
                return fail("INVALID_INPUT", `查询窗口最长 ${MAX_WINDOW_DAYS} 天（含首尾，上游限制），请缩小范围`);
            }

            try {
                // 日历事件 + 全部课程的作业（并行）
                const [events, courses] = await Promise.all([
                    client.getCalendar(startDate.replaceAll("-", ""), endDate.replaceAll("-", "")),
                    client.getCourses(),
                ]);
                const perCourse = await Promise.all(
                    courses.map(async (c) => ({
                        name: courseDisplayName(c),
                        homework: await client.getHomeworkList(c.id),
                    })),
                );
                const startTs = Date.parse(`${startDate}T00:00:00+08:00`);
                const endTs = Date.parse(`${endDate}T23:59:59+08:00`);
                const homeworkDeadlines = perCourse
                    .flatMap(({name, homework}) =>
                        homework
                            .filter((h) =>
                                h.deadline instanceof Date &&
                                h.deadline.getTime() > 0 &&
                                h.deadline.getTime() >= startTs &&
                                h.deadline.getTime() <= endTs,
                            )
                            .map((h) => ({
                                course: name,
                                title: h.title,
                                deadline: formatBeijing(h.deadline),
                                status: (h.graded ? "graded" : h.submitted ? "submitted" : "unsubmitted") as
                                    "unsubmitted" | "submitted" | "graded",
                            })),
                    )
                    .sort((a, b) => a.deadline.localeCompare(b.deadline));

                return ok({
                    startDate,
                    endDate,
                    events: events.map((e) => ({
                        date: e.date,
                        courseName: e.courseName,
                        startTime: e.startTime,
                        endTime: e.endTime,
                        location: e.location,
                        status: e.status,
                    })),
                    homeworkDeadlines,
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
