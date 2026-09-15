/**
 * Skill: get_learn_courses —— 查询网络学堂（learn.tsinghua.edu.cn）的课程列表。
 *
 * 这是学堂其他技能的基础：课名关键词 → 课程的对应关系可以从这里拿到。
 * 注意与 get_schedule 的区别：get_schedule 是教务的上课时间表（几点在哪上课），
 * 本技能是网络学堂的课程空间（通知/作业/课件的归属）。
 */
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {courseDisplayName, matchCourses, type CourseSource} from "./courseResolve";

export interface LearnCoursesData {
    /** 学期 ID，如 "2025-2026-2" */
    semester: string;
    count: number;
    courses: {
        name: string;
        teacher: string;
        courseNumber: string;
        /** 上课时间地点，如 ["1-3 09:50-11:25 六教6A214"]（可能为空） */
        timeAndLocation: string[];
    }[];
}

export function createGetLearnCoursesSkill(client: CourseSource): Skill {
    return {
        name: "get_learn_courses",
        description:
            "查询网络学堂（清华 learn.tsinghua.edu.cn）当前学期的课程列表：课名、教师、上课时间地点。" +
            "这是学堂通知/作业/课件技能的配套工具——用户说课名关键词时先用它确认对应哪门课。" +
            "注意：查「几点在哪上课」用 get_schedule，本工具查的是学堂课程空间。",
        inputSchema: {
            type: "object",
            properties: {
                keyword: {
                    type: "string",
                    description: "可选，课名/课号关键词过滤，如“数据结构”；省略时返回全部课程",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<LearnCoursesData>> {
            const raw = (input ?? {}) as {keyword?: unknown};
            if (raw.keyword !== undefined && typeof raw.keyword !== "string") {
                return fail("INVALID_INPUT", "keyword 必须是字符串，如“数据结构”");
            }
            try {
                const [semester, all] = await Promise.all([
                    client.getCurrentSemester(),
                    client.getCourses(),
                ]);
                const courses = matchCourses(all, raw.keyword?.trim() ?? "");
                if (courses.length === 0) {
                    return fail(
                        "NOT_FOUND",
                        all.length === 0
                            ? "本学期在网络学堂没有查到课程"
                            : `找不到名称含“${raw.keyword}”的课程。本学期课程有：${all.map(courseDisplayName).join("、")}`,
                    );
                }
                return ok({
                    semester: semester.id,
                    count: courses.length,
                    courses: courses.map((c) => ({
                        name: courseDisplayName(c),
                        teacher: c.teacherName,
                        courseNumber: c.courseNumber,
                        timeAndLocation: c.timeAndLocation,
                    })),
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
