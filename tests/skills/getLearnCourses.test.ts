/**
 * get_learn_courses 与课程解析逻辑测试（假数据，无网络）。
 *
 * 通过注入假的 CourseSource 验证：关键词过滤、NOT_FOUND 候选提示、
 * 读操作扇出、写操作唯一匹配（AMBIGUOUS）。
 */
import {describe, expect, it} from "vitest";
import {CourseType, type CourseInfo, type SemesterInfo} from "thu-learn-lib";
import {createGetLearnCoursesSkill, type LearnCoursesData} from "../../src/skills/learn/getLearnCourses";
import {resolveCourses, resolveUniqueCourse} from "../../src/skills/learn/courseResolve";

const fakeSemester: SemesterInfo = {
    id: "2025-2026-2",
    startDate: new Date("2026-02-23"),
    endDate: new Date("2026-07-05"),
    startYear: 2025,
    endYear: 2026,
    type: "spring" as SemesterInfo["type"],
};

const makeCourse = (chineseName: string, courseNumber: string, teacher = "张三"): CourseInfo => ({
    id: `2025-2026-2-${courseNumber}`,
    name: `${chineseName}(English Name)`,
    chineseName,
    englishName: "English Name",
    timeAndLocation: ["1-3 09:50-11:25 六教6A214"],
    url: "https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/course?wlkcid=x",
    teacherName: teacher,
    teacherNumber: "2020000001",
    courseNumber,
    courseIndex: 0,
    courseType: CourseType.STUDENT,
});

const fakeCourses: CourseInfo[] = [
    makeCourse("数据结构", "30240163"),
    makeCourse("大学物理B(1)", "10430484"),
    makeCourse("数学实验", "10420855"),
];

const fakeClient = {
    getCurrentSemester: async () => fakeSemester,
    getCourses: async (semesterId?: string) => {
        if (semesterId && semesterId !== fakeSemester.id) return [];
        return fakeCourses;
    },
};

const skill = createGetLearnCoursesSkill(fakeClient);

const exec = async (input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: LearnCoursesData; error?: {code: string; message: string}};

describe("get_learn_courses Skill（假数据，无网络）", () => {
    it("省略参数时返回本学期全部课程", async () => {
        const r = await exec();
        expect(r.success).toBe(true);
        expect(r.data!.semester).toBe("2025-2026-2");
        expect(r.data!.count).toBe(3);
        expect(r.data!.courses[0]).toMatchObject({
            name: "数据结构",
            teacher: "张三",
            courseNumber: "30240163",
        });
    });

    it("按课名关键词过滤（中文/课号均可）", async () => {
        let r = await exec({keyword: "数据"});
        expect(r.data!.count).toBe(1);
        expect(r.data!.courses[0].name).toBe("数据结构");
        r = await exec({keyword: "10430484"});
        expect(r.data!.courses[0].name).toBe("大学物理B(1)");
    });

    it("关键词无匹配时报 NOT_FOUND 并给出全部课程候选", async () => {
        const r = await exec({keyword: "不存在的课"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
        expect(r.error!.message).toContain("数据结构");
        expect(r.error!.message).toContain("大学物理B(1)");
    });

    it("拒绝非法输入", async () => {
        const r = await exec({keyword: 42});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
    });
});

describe("课程解析（读操作扇出 / 写操作唯一）", () => {
    it("读操作：省略关键词时扇出到全部课程", async () => {
        const {result, error} = await resolveCourses(fakeClient);
        expect(error).toBeUndefined();
        expect(result!.courses).toHaveLength(3);
    });

    it("读操作：关键词匹配多门时全部返回", async () => {
        const {result} = await resolveCourses(fakeClient, "学");
        expect(result!.courses.map((c) => c.chineseName)).toEqual(["大学物理B(1)", "数学实验"]);
    });

    it("写操作：唯一匹配成功", async () => {
        const {course, error} = await resolveUniqueCourse(fakeClient, "数据结构");
        expect(error).toBeUndefined();
        expect(course!.courseNumber).toBe("30240163");
    });

    it("写操作：多匹配报 AMBIGUOUS 并列出候选", async () => {
        const {error} = await resolveUniqueCourse(fakeClient, "学");
        expect(error!.success).toBe(false);
        expect(error!.error!.code).toBe("AMBIGUOUS");
        expect(error!.error!.message).toContain("大学物理B(1)");
        expect(error!.error!.message).toContain("数学实验");
    });

    it("写操作：无匹配报 NOT_FOUND", async () => {
        const {error} = await resolveUniqueCourse(fakeClient, "化学");
        expect(error!.error!.code).toBe("NOT_FOUND");
    });
});
