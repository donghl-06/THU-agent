/**
 * get_learn_notices 与 htmlToText 测试（假数据，无网络）。
 */
import {describe, expect, it} from "vitest";
import {CourseType, type CourseInfo, type Notification, type SemesterInfo} from "thu-learn-lib";
import {createGetLearnNoticesSkill, type LearnNoticesData} from "../../src/skills/learn/getLearnNotices";
import {htmlToText} from "../../src/utils/htmlToText";

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

const makeNotice = (title: string, publishTime: string, hasRead: boolean, withAttachment = false): Notification => ({
    id: `n-${title}`,
    title,
    content: `<p>各位同学：</p><p>${title}的<strong>详细</strong>说明 &amp; 注意事项</p>`,
    hasRead,
    url: "",
    markedImportant: false,
    publishTime: new Date(publishTime),
    publisher: "李老师",
    isFavorite: false,
    ...(withAttachment
        ? {
            attachment: {
                id: "att-1",
                name: "讲义.pdf",
                downloadUrl: "https://learn.tsinghua.edu.cn/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?wjid=1",
                previewUrl: "",
                size: "1M",
            },
        }
        : {}),
});

const courses = [makeCourse("数据结构", "30240163"), makeCourse("大学物理B(1)", "10430484")];

const noticesByCourse: Record<string, Notification[]> = {
    "course-30240163": [
        makeNotice("期中考试安排", "2026-09-10T02:00:00Z", false, true),
        makeNotice("作业延期通知", "2026-09-05T02:00:00Z", true),
    ],
    "course-10430484": [makeNotice("实验分组", "2026-09-08T02:00:00Z", false)],
};

const fakeClient = {
    getCurrentSemester: async () => fakeSemester,
    getCourses: async () => courses,
    getNotifications: async (courseId: string) => noticesByCourse[courseId] ?? [],
};

const skill = createGetLearnNoticesSkill(fakeClient);

const exec = async (input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: LearnNoticesData; error?: {code: string; message: string}};

describe("get_learn_notices Skill（假数据，无网络）", () => {
    it("省略 course 时聚合全部课程并按时间倒序", async () => {
        const r = await exec();
        expect(r.success).toBe(true);
        expect(r.data!.count).toBe(3);
        expect(r.data!.notices.map((n) => n.title)).toEqual([
            "期中考试安排",
            "实验分组",
            "作业延期通知",
        ]);
        expect(r.data!.notices[0].course).toBe("数据结构");
    });

    it("正文剥成纯文本、附件信息保留", async () => {
        const r = await exec({course: "数据结构"});
        const first = r.data!.notices[0];
        expect(first.content).toBe("各位同学：\n期中考试安排的详细说明 & 注意事项");
        expect(first.attachment).toMatchObject({name: "讲义.pdf", size: "1M"});
        expect(first.publishTime).toBe("2026-09-10 10:00"); // UTC+8
    });

    it("unreadOnly 只看未读", async () => {
        const r = await exec({unreadOnly: true});
        expect(r.data!.count).toBe(2);
        expect(r.data!.notices.every((n) => !n.hasRead)).toBe(true);
    });

    it("limit 截断与非法输入", async () => {
        let r = await exec({limit: 1});
        expect(r.data!.count).toBe(1);
        r = await exec({limit: 0});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        r = await exec({course: 42});
        expect(r.error!.code).toBe("INVALID_INPUT");
    });

    it("课名无匹配时 NOT_FOUND 带候选", async () => {
        const r = await exec({course: "化学"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
        expect(r.error!.message).toContain("数据结构");
    });
});

describe("htmlToText", () => {
    it("去标签、解码实体、收敛空白", () => {
        expect(htmlToText("<p>第一段</p><p>第二段&nbsp;&amp;</p>")).toBe("第一段\n第二段 &");
        expect(htmlToText("<!-- 注释 --><b>加粗</b>")).toBe("加粗");
        expect(htmlToText("")).toBe("");
        expect(htmlToText(undefined)).toBe("");
    });

    it("script/style 内容整体丢弃", () => {
        expect(htmlToText('<p>正文</p><script>alert(1)</script>')).toBe("正文");
    });
});
