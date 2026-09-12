/**
 * submit_learn_homework Skill 测试（假 client + 临时文件，无网络）。
 *
 * 写操作重点验证：课程/作业必须唯一匹配、线下作业与已过截止被拒、
 * 文件缺失被拒、成功路径把正确的内容交给 client.submitHomework。
 */
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {
    CourseType,
    HomeworkCompletionType,
    HomeworkSubmissionType,
    type CourseInfo,
    type Homework,
    type SemesterInfo,
} from "thu-learn-lib";
import {
    createSubmitLearnHomeworkSkill,
    type SubmitLearnHomeworkData,
} from "../../src/skills/learn/submitLearnHomework";

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
    opts: {submitted?: boolean; deadline?: Date; lateDeadline?: Date; offline?: boolean} = {},
): Homework => ({
    id: `hw-${title}`,
    studentHomeworkId: `hw-${title}`,
    baseId: `base-${title}`,
    title,
    deadline: opts.deadline ?? new Date("2099-01-01T00:00:00Z"),
    ...(opts.lateDeadline ? {lateSubmissionDeadline: opts.lateDeadline} : {}),
    url: "",
    completionType: HomeworkCompletionType.INDIVIDUAL,
    submissionType: opts.offline ? HomeworkSubmissionType.OFFLINE : HomeworkSubmissionType.WEB_LEARNING,
    submitUrl: "",
    isLateSubmission: false,
    isFavorite: false,
    submitted: opts.submitted ?? false,
    graded: false,
});

const courses = [
    makeCourse("数据结构", "30240163"),
    makeCourse("数据库概论", "30240262"),
];

const homeworkByCourse: Record<string, Homework[]> = {
    "course-30240163": [
        makeHomework("第三次作业"),
        makeHomework("期中复习作业A", {}),
        makeHomework("期中复习作业B", {}),
        makeHomework("实验报告", {offline: true}),
        makeHomework("已截止作业", {deadline: new Date("2020-01-01T00:00:00Z")}),
        makeHomework("迟交作业", {
            deadline: new Date("2020-01-01T00:00:00Z"),
            lateDeadline: new Date("2099-01-02T00:00:00Z"),
        }),
        makeHomework("已交过的作业", {submitted: true}),
    ],
    "course-30240262": [],
};

interface SubmitCall {
    id: string;
    content: string;
    filename: string;
    size: number;
}

const submitCalls: SubmitCall[] = [];

const fakeClient = {
    getCurrentSemester: async () => fakeSemester,
    getCourses: async () => courses,
    getHomeworkList: async (courseId: string) => homeworkByCourse[courseId] ?? [],
    submitHomework: async (id: string, content: string, attachment?: {filename: string; content: Blob}) => {
        submitCalls.push({
            id,
            content,
            filename: attachment?.filename ?? "",
            size: attachment ? attachment.content.size : 0,
        });
    },
};

const skill = createSubmitLearnHomeworkSkill(fakeClient);

const exec = async (input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: SubmitLearnHomeworkData; error?: {code: string; message: string}};

let dir = "";
let pdfPath = "";

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "qingling-learn-"));
    pdfPath = join(dir, "hw3.pdf");
    await writeFile(pdfPath, Buffer.from("%PDF-1.4 fake pdf content"));
    await writeFile(join(dir, "empty.pdf"), Buffer.alloc(0));
});

afterAll(async () => {
    await rm(dir, {recursive: true, force: true});
});

describe("submit_learn_homework Skill（假 client + 临时文件）", () => {
    it("成功提交：正确传递作业 ID、文件名与内容", async () => {
        const r = await exec({course: "数据结构", homework: "第三次作业", filePath: pdfPath, content: "请老师查收"});
        expect(r.success).toBe(true);
        expect(r.data!.course).toBe("数据结构");
        expect(r.data!.homework).toBe("第三次作业");
        expect(r.data!.filename).toBe("hw3.pdf");
        expect(r.data!.overwritten).toBe(false);
        const call = submitCalls.at(-1)!;
        expect(call.id).toBe("hw-第三次作业");
        expect(call.content).toBe("请老师查收");
        expect(call.filename).toBe("hw3.pdf");
        expect(call.size).toBeGreaterThan(0);
    });

    it("重复提交标记 overwritten", async () => {
        const r = await exec({course: "数据结构", homework: "已交过的作业", filePath: pdfPath});
        expect(r.success).toBe(true);
        expect(r.data!.overwritten).toBe(true);
        expect(r.data!.message).toContain("覆盖");
    });

    it("课程歧义报 AMBIGUOUS（数据 → 数据结构/数据库概论）", async () => {
        const r = await exec({course: "数据", homework: "第三次作业", filePath: pdfPath});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("AMBIGUOUS");
        expect(r.error!.message).toContain("数据库概论");
    });

    it("作业歧义报 AMBIGUOUS（期中复习 → A/B 两份）", async () => {
        const r = await exec({course: "数据结构", homework: "期中复习", filePath: pdfPath});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("AMBIGUOUS");
        expect(r.error!.message).toContain("期中复习作业A");
        expect(r.error!.message).toContain("期中复习作业B");
    });

    it("作业不存在报 NOT_FOUND 并列出现有作业", async () => {
        const r = await exec({course: "数据结构", homework: "第九次", filePath: pdfPath});
        expect(r.error!.code).toBe("NOT_FOUND");
        expect(r.error!.message).toContain("第三次作业");
    });

    it("线下作业拒绝提交", async () => {
        const r = await exec({course: "数据结构", homework: "实验报告", filePath: pdfPath});
        expect(r.error!.code).toBe("NOT_SUBMITTABLE");
    });

    it("已过最终截止拒绝提交；迟交窗口内允许", async () => {
        let r = await exec({course: "数据结构", homework: "已截止作业", filePath: pdfPath});
        expect(r.error!.code).toBe("DEADLINE_PASSED");
        r = await exec({course: "数据结构", homework: "迟交作业", filePath: pdfPath});
        expect(r.success).toBe(true);
        expect(r.data!.message).toContain("迟交");
    });

    it("文件缺失/空文件被拒", async () => {
        let r = await exec({course: "数据结构", homework: "第三次作业", filePath: join(dir, "nope.pdf")});
        expect(r.error!.code).toBe("FILE_NOT_FOUND");
        r = await exec({course: "数据结构", homework: "第三次作业", filePath: join(dir, "empty.pdf")});
        expect(r.error!.code).toBe("INVALID_INPUT");
    });

    it("必填参数缺失被拒", async () => {
        for (const input of [
            {homework: "第三次作业", filePath: pdfPath},
            {course: "数据结构", filePath: pdfPath},
            {course: "数据结构", homework: "第三次作业"},
            {course: "", homework: "第三次作业", filePath: pdfPath},
        ]) {
            const r = await exec(input);
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
    });

    it("requiresConfirmation 标记为 true", () => {
        expect(skill.requiresConfirmation).toBe(true);
    });
});
