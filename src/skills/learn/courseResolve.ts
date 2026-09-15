/**
 * 网络学堂技能共享的课程解析逻辑。
 *
 * 模型听到的是「数据结构」「大物」这种口语关键词，不是 courseID。
 * 读操作（通知/作业/课件）允许扇出：关键词匹配几门课就聚合几门课的结果；
 * 写操作（提交作业）必须唯一匹配，歧义时返回候选让模型回去问——绝不能乱交。
 */
import type {CourseInfo} from "thu-learn-lib";
import type {LearnClient} from "../../client/learn/LearnClient";
import {fail, type SkillResult} from "../base/types";

export type CourseSource = Pick<LearnClient, "getCourses" | "getCurrentSemester">;

/** 课程展示名（中文名优先，比 name（中英混合）更适合念给用户） */
export function courseDisplayName(c: CourseInfo): string {
    return c.chineseName || c.name;
}

/** 关键词匹配课程：课名（中/英）或课号包含关键词即可，大小写不敏感 */
export function matchCourses(courses: CourseInfo[], keyword: string): CourseInfo[] {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return courses;
    return courses.filter((c) =>
        c.chineseName.toLowerCase().includes(kw) ||
        c.name.toLowerCase().includes(kw) ||
        c.englishName.toLowerCase().includes(kw) ||
        c.courseNumber.toLowerCase().includes(kw),
    );
}

export interface ResolvedCourses {
    semesterId: string;
    courses: CourseInfo[];
}

/**
 * 读操作用：解析关键词到一组课程（可为全部）。
 * 失败时返回 SkillResult 错误（含可选课程清单，方便模型引导用户换说法）。
 */
export async function resolveCourses(
    client: CourseSource,
    keyword?: string,
    semesterId?: string,
): Promise<{result?: ResolvedCourses; error?: SkillResult<never>}> {
    const all = await client.getCourses(semesterId);
    if (all.length === 0) {
        return {error: fail("NOT_FOUND", "该学期在网络学堂没有查到课程")};
    }
    const matched = keyword?.trim() ? matchCourses(all, keyword) : all;
    if (matched.length === 0) {
        const names = all.map(courseDisplayName).join("、");
        return {
            error: fail(
                "NOT_FOUND",
                `找不到名称含“${keyword}”的课程。本学期课程有：${names}`,
            ),
        };
    }
    const semester = semesterId ?? (await client.getCurrentSemester()).id;
    return {result: {semesterId: semester, courses: matched}};
}

/**
 * 写操作用：解析关键词到唯一一门课。歧义/无匹配都报错（候选名单放进 message）。
 */
export async function resolveUniqueCourse(
    client: CourseSource,
    keyword: string,
    semesterId?: string,
): Promise<{course?: CourseInfo; error?: SkillResult<never>}> {
    const {result, error} = await resolveCourses(client, keyword, semesterId);
    if (error) return {error};
    const {courses} = result!;
    if (courses.length > 1) {
        const names = courses.map(courseDisplayName).join("、");
        return {
            error: fail(
                "AMBIGUOUS",
                `“${keyword}”匹配到 ${courses.length} 门课：${names}。请用更具体的课名。`,
            ),
        };
    }
    return {course: courses[0]};
}
