/**
 * get_learn_calendar Skill 测试（假数据，无网络）。
 */
import {describe, expect, it} from "vitest";
import {
    CourseType,
    HomeworkCompletionType,
    HomeworkSubmissionType,
    type CalendarEvent,
    type CourseInfo,
    type Homework,
    type SemesterInfo,
} from "thu-learn-lib";
import {createGetLearnCalendarSkill, type LearnCalendarData} from "../../src/skills/learn/getLearnCalendar";

const fakeSemester: SemesterInfo = {
    id: "2025-2026-2",
    startDate: new Date("2026-02-23"),
    endDate: new Date("2026-07-05"),
    startYear: 2025,
    endYear: 2026,
    type: "spring" as SemesterInfo["type"],
};

const makeCourse = (chineseName: string): CourseInfo => ({
    id: `course-${chineseName}`,
    name: chineseName,
    chineseName,
    englishName: "",
    timeAndLocation: [],
    url: "",
    teacherName: "张三",
    teacherNumber: "",
    courseNumber: "30240000",
    courseIndex: 0,
    courseType: CourseType.STUDENT,
});

const makeHomework = (title: string, deadline: Date | null, submitted = false): Homework => ({
    id: `hw-${title}`,
    studentHomeworkId: `hw-${title}`,
    baseId: `base-${title}`,
    title,
    deadline: deadline as unknown as Date,
    url: "",
    completionType: HomeworkCompletionType.INDIVIDUAL,
    submissionType: HomeworkSubmissionType.WEB_LEARNING,
    submitUrl: "",
    isLateSubmission: false,
    isFavorite: false,
    submitted,
    graded: false,
});

const fakeEvents: CalendarEvent[] = [
    {
        date: "2026-09-15",
        courseName: "数据结构",
        startTime: "09:50",
        endTime: "11:25",
        location: "六教6A214",
        status: "上课",
    },
];

const courses = [makeCourse("数据结构")];

const homeworkByCourse: Record<string, Homework[]> = {
    "course-数据结构": [
        // 窗口内：2026-09-20 23:59 北京 = 2026-09-20T15:59:00Z
        makeHomework("窗口内作业", new Date("2026-09-20T15:59:00Z")),
        // 窗口外
        makeHomework("窗口外作业", new Date("2026-12-01T15:59:00Z")),
        // 已交（也应在清单里,标注状态）
        makeHomework("窗口内已交作业", new Date("2026-09-18T15:59:00Z"), true),
        // 无截止
        makeHomework("无截止作业", null),
    ],
};

let lastCalendarArgs: {start: string; end: string} | undefined;

const fakeClient = {
    getCurrentSemester: async () => fakeSemester,
    getCourses: async () => courses,
    getCalendar: async (start: string, end: string) => {
        lastCalendarArgs = {start, end};
        return fakeEvents;
    },
    getHomeworkList: async (courseId: string) => homeworkByCourse[courseId] ?? [],
};

const skill = createGetLearnCalendarSkill(fakeClient);

const exec = async (input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: LearnCalendarData; error?: {code: string; message: string}};

describe("get_learn_calendar Skill（假数据，无网络）", () => {
    it("返回日历事件 + 窗口内作业截止（按时间升序、带状态）", async () => {
        const r = await exec({startDate: "2026-09-13", endDate: "2026-09-26"});
        expect(r.success).toBe(true);
        // 日期转 yyyymmdd 传给上游
        expect(lastCalendarArgs).toEqual({start: "20260913", end: "20260926"});
        expect(r.data!.events).toHaveLength(1);
        expect(r.data!.events[0]).toMatchObject({courseName: "数据结构", location: "六教6A214"});
        const titles = r.data!.homeworkDeadlines.map((h) => h.title);
        expect(titles).toEqual(["窗口内已交作业", "窗口内作业"]); // 9-18 在 9-20 前
        expect(r.data!.homeworkDeadlines[0].status).toBe("submitted");
        expect(r.data!.homeworkDeadlines[1].status).toBe("unsubmitted");
        expect(r.data!.homeworkDeadlines[1].deadline).toBe("2026-09-20 23:59");
    });

    it("省略参数时默认今天起 14 天窗口", async () => {
        const r = await exec();
        expect(r.success).toBe(true);
        expect(r.data!.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.data!.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // 窗口 13 天间隔（14 天含首尾）
        const days = (Date.parse(r.data!.endDate) - Date.parse(r.data!.startDate)) / 86400000;
        expect(days).toBe(13);
    });

    it("窗口超过 29 天被拒", async () => {
        const r = await exec({startDate: "2026-09-01", endDate: "2026-10-15"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("29");
    });

    it("endDate 早于 startDate / 日期格式非法被拒", async () => {
        let r = await exec({startDate: "2026-09-26", endDate: "2026-09-13"});
        expect(r.error!.code).toBe("INVALID_INPUT");
        for (const bad of ["2026/09/13", "明天", "20260913"]) {
            r = await exec({startDate: bad});
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
    });
});
