/**
 * Skill: get_report —— 查询成绩单（全部学期的课程成绩）。
 *
 * 输出是课程数组（名称/学分/等级/绩点/学期），可选按学期关键词过滤。
 * GPA 计算交给模型按绩点自行估算，skill 不替它算。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface ReportData {
    /** 课程数 */
    count: number;
    courses: {
        name: string;
        credit: number;
        /** 等级（A/A-/B+/…/P/F） */
        grade: string;
        /** 绩点 */
        point: number;
        /** 学期，如 "2025-2026-1" */
        semester: string;
    }[];
}

type ReportSource = Pick<ThuClient, "getReport">;

export function createGetReportSkill(client: ReportSource): Skill {
    return {
        name: "get_report",
        description:
            "查询当前用户的成绩单：全部学期的课程名称、学分、等级、绩点。" +
            "可用 semester 参数按学期过滤（如“2025-2026-1”）。",
        inputSchema: {
            type: "object",
            properties: {
                semester: {
                    type: "string",
                    description: "可选，学期关键词过滤，如“2025-2026-1”；省略时返回全部学期",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<ReportData>> {
            const raw = (input ?? {}) as {semester?: unknown};
            if (raw.semester !== undefined && typeof raw.semester !== "string") {
                return fail("INVALID_INPUT", "semester 必须是字符串，如“2025-2026-1”");
            }
            try {
                const report = await client.getReport();
                const keyword = raw.semester?.trim();
                const courses = report
                    .filter((c) => !keyword || c.semester.includes(keyword))
                    .map((c) => ({
                        name: c.name,
                        credit: c.credit,
                        grade: c.grade,
                        point: c.point,
                        semester: c.semester,
                    }));
                if (courses.length === 0) {
                    return fail(
                        "NOT_FOUND",
                        keyword ? `没有找到学期包含“${keyword}”的成绩记录` : "没有查到任何成绩记录",
                    );
                }
                return ok({count: courses.length, courses});
            } catch (e) {
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e;
            }
        },
    };
}
