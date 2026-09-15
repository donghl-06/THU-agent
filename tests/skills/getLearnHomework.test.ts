/**
 * get_learn_homework Skill 测试（假数据，无网络）。
 */
import {describe, expect, it} from "vitest";
import {
    CourseType,
    HomeworkCompletionType,
    HomeworkGradeLevel,
    HomeworkSubmissionType,
    type CourseInfo,
    type Homework,
    type SemesterInfo,
} from "thu-learn-lib";
import {createGetLearnHomeworkSkill, type LearnHomeworkData} from "../../src/skills/learn/getLearnHomework";

const fakeSemester: SemesterInfo = {
    id: "2025-2026-2",
    startDate: new Date("2026-02-23"),
    endDate: new Date("2026-07-05"),
    startYear: 2025,
    endYear: 2026,
    type: "spring" as SemesterInfo["type"],
};

const makeCourse = (chineseName: string, courseNumber: string): CourseInfo => ({
    id: `course-${courseNumber}`,
    name: chineseName,
    chineseName,
    englishName: "",
    timeAndLocation: [],
    url: "",
    teacherName: "张三",
    teacherNumber: "",
    courseNumber,
    courseIndex: 0,
    courseType: CourseType.STUDENT,
});

const makeHomework = (
    title: string,
    opts: {
        deadline?: Date | null;
        submitted?: boolean;
        graded?: boolean;
        grade?: number;
        gradeLevel?: HomeworkGradeLevel;
        gradeContent?: string;
        submissionType?: HomeworkSubmissionType;
        description?: string;
        submitTime?: Date;
    } = {},
): Homework => ({
    id: `hw-${title}`,
    studentHomeworkId: `hw-${title}`,
    baseId: `base-${title}`,
    title,
    deadline: opts.deadline === null ? (null as unknown as Date) : (opts.deadline ?? new Date("2026-09-20T15:59:00Z")),
    url: "",
    completionType: HomeworkCompletionType.INDIVIDUAL,
    submissionType: opts.submissionType ?? HomeworkSubmissionType.WEB_LEARNING,
    submitUrl: "",
    isLateSubmission: false,
    isFavorite: false,
    submitted: opts.submitted ?? false,
    graded: opts.graded ?? false,
    ...(opts.submitTime ? {submitTime: opts.submitTime} : {}),
    ...(opts.grade !== undefined ? {grade: opts.grade} : {}),
    ...(opts.gradeLevel ? {gradeLevel: opts.gradeLevel} : {}),
    ...(opts.gradeContent ? {gradeContent: opts.gradeContent} : {}),
    ...(opts.description ? {description: opts.description} : {}),
});

const courses = [makeCourse("数据结构", "30240163"), makeCourse("大学物理B(1)", "10430484")];

const homeworkByCourse: Record<string, Homework[]> = {
    "course-30240163": [
        makeHomework("第三次作业", {deadline: new Date("2099-01-01T15:59:00Z"), description: "<p>完成第 3 章习题</p>"}),
        makeHomework("第一次作业", {
            submitted: true,
            graded: true,
            gradeLevel: HomeworkGradeLevel.A_MINUS,
            gradeContent: "<p>第 2 题思路有误</p>",
            submitTime: new Date("2026-09-01T08:00:00Z"),
        }),
    ],
    "course-10430484": [
        makeHomework("实验报告", {submissionType: HomeworkSubmissionType.OFFLINE}),
        makeHomework("无截止作业", {deadline: null}),
    ],
};

const fakeClient = {
    getCurrentSemester: async () => fakeSemester,
    getCourses: async () => courses,
    getHomeworkList: async (courseId: string) => homeworkByCourse[courseId] ?? [],
};

const skill = createGetLearnHomeworkSkill(fakeClient);

const exec = async (input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: LearnHomeworkData; error?: {code: string; message: string}};

describe("get_learn_homework Skill（假数据，无网络）", () => {
    it("聚合全部课程，按截止时间升序、无截止排最后", async () => {
        const r = await exec();
        expect(r.success).toBe(true);
        expect(r.data!.count).toBe(4);
        const titles = r.data!.homework.map((h) => h.title);
        expect(titles[titles.length - 1]).toBe("无截止作业");
        expect(titles.indexOf("实验报告")).toBeLessThan(titles.indexOf("第三次作业"));
    });

    it("默认 deadline 的作业与 overdue 判定", async () => {
        const r = await exec({course: "物理", status: "unsubmitted"});
        expect(r.data!.count).toBe(2);
        const report = r.data!.homework.find((h) => h.title === "实验报告")!;
        // 默认 deadline 2026-09-20（今天 2026-09-13 之前之后由运行时决定，这里只验证字段存在）
        expect(report.deadline).toBe("2026-09-20 23:59");
        expect(typeof report.overdue).toBe("boolean");
        expect(report.submissionType).toBe("offline");
        const noDeadline = r.data!.homework.find((h) => h.title === "无截止作业")!;
        expect(noDeadline.deadline).toBeNull();
        expect(noDeadline.overdue).toBe(false);
    });

    it("status=unsubmitted 只返回未交", async () => {
        const r = await exec({status: "unsubmitted"});
        expect(r.data!.homework.every((h) => h.status === "unsubmitted")).toBe(true);
        expect(r.data!.homework.some((h) => h.title === "第一次作业")).toBe(false);
    });

    it("status=graded 返回成绩与评语（HTML 剥除）", async () => {
        const r = await exec({status: "graded"});
        expect(r.data!.count).toBe(1);
        const hw = r.data!.homework[0];
        expect(hw.title).toBe("第一次作业");
        expect(hw.grade).toBe("A-");
        expect(hw.gradeComment).toBe("第 2 题思路有误");
        expect(hw.submittedAt).toBe("2026-09-01 16:00");
    });

    it("描述剥成纯文本", async () => {
        const r = await exec({course: "数据结构", status: "unsubmitted"});
        expect(r.data!.homework[0].description).toBe("完成第 3 章习题");
        expect(r.data!.homework[0].images).toBeUndefined();
    });

    it("描述内嵌图片提取到 images 字段，描述留 [图片N] 占位", async () => {
        const client = {...fakeClient, getHomeworkList: async () => [
            makeHomework("上机作业", {
                deadline: new Date("2099-01-01T15:59:00Z"),
                description: `<p>按下图连线：</p><img src="/upload/2026/topo.jpg">`,
            }),
        ]};
        const s = createGetLearnHomeworkSkill(client);
        const r = (await s.execute({course: "数据结构"})) as
            {success: boolean; data?: LearnHomeworkData};
        expect(r.success).toBe(true);
        expect(r.data!.homework[0].description).toBe("按下图连线：\n[图片1]");
        expect(r.data!.homework[0].images).toEqual([
            {index: 1, url: "https://learn.tsinghua.edu.cn/upload/2026/topo.jpg"},
        ]);
    });

    it("无未交作业时 NOT_FOUND 文案友好", async () => {
        const client = {...fakeClient, getHomeworkList: async () => [
            makeHomework("已交作业", {submitted: true}),
        ]};
        const s = createGetLearnHomeworkSkill(client);
        const r = (await s.execute({status: "unsubmitted"})) as {success: boolean; error?: {message: string}};
        expect(r.success).toBe(false);
        expect(r.error!.message).toBe("没有未交的作业");
    });

    it("非法输入校验", async () => {
        for (const input of [{status: "unknown"}, {limit: 0}, {course: 1}]) {
            const r = await exec(input);
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
    });
});
