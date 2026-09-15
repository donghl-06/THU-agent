/**
 * show_learn_image Skill 测试（假 client + 真实 TempImageStore 临时目录，无网络）。
 */
import {mkdtempSync, rmSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {CourseType, type CourseInfo, type File as LearnFile, type Notification, type Homework, type SemesterInfo} from "thu-learn-lib";
import {createShowLearnImageSkill, type ShowLearnImageData} from "../../src/skills/learn/showLearnImage";
import {TempImageStore} from "../../src/utils/tempImageStore";

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

const makeFile = (title: string, remoteName: string): LearnFile => ({
    id: `f-${title}`,
    fileId: `fid-${title}`,
    rawSize: 1024,
    size: "1K",
    title,
    description: "",
    uploadTime: new Date("2026-09-10T02:00:00Z"),
    publishTime: new Date("2026-09-10T02:00:00Z"),
    downloadUrl: `https://learn.tsinghua.edu.cn/download/${remoteName}`,
    previewUrl: "",
    isNew: false,
    markedImportant: false,
    visitCount: 0,
    downloadCount: 0,
    fileType: remoteName.split(".").pop() ?? "",
    remoteFile: {
        id: `rf-${title}`,
        name: remoteName,
        downloadUrl: `https://learn.tsinghua.edu.cn/download/${remoteName}`,
        previewUrl: "",
        size: "1K",
    },
});

const courses = [makeCourse("数据结构", "30240163")];
// 一张图 + 一个 PDF：自动选图应命中二维码；物理课两张图：自动选应歧义
const filesByCourse: Record<string, LearnFile[]> = {
    "course-30240163": [
        makeFile("课程群二维码", "qrcode.jpg"),
        makeFile("第三章课件", "ch3.pdf"),
    ],
};

/** content-type 故意给 octet-stream，验证扩展名兜底判定 */
const fakeClient = {
    getCurrentSemester: async () => fakeSemester,
    getCourses: async () => courses,
    getFileList: async (courseId: string) => filesByCourse[courseId] ?? [],
    // 正文内嵌图模式才用到，课件模式给空桩即可
    getNotifications: async () => [] as Notification[],
    getHomeworkList: async () => [] as Homework[],
    downloadFile: async (url: string) => ({
        buffer: Buffer.from(`bytes of ${url}`),
        filename: undefined as string | undefined,
        contentType: "application/octet-stream",
    }),
};

let dir = "";
let store: TempImageStore;
afterEach(() => {
    if (dir) rmSync(dir, {recursive: true, force: true});
    dir = "";
});

const setup = (client = fakeClient) => {
    dir = mkdtempSync(join(tmpdir(), "qingling-showlearn-test-"));
    store = new TempImageStore(dir);
    return createShowLearnImageSkill(client, store);
};

const exec = async (skill: ReturnType<typeof setup>, input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: ShowLearnImageData; error?: {code: string; message: string}};

describe("show_learn_image Skill（假数据，无网络）", () => {
    it("不给 file 时自动选唯一图片课件，content-type 按扩展名归一化", async () => {
        const skill = setup();
        const r = await exec(skill, {course: "数据结构"});
        expect(r.success).toBe(true);
        expect(r.data!.title).toBe("课程群二维码");
        expect(r.data!.contentType).toBe("image/jpeg"); // octet-stream → 扩展名兜底
        expect(r.data!.markdown).toBe(`![课程群二维码](${r.data!.imageUrl})`);
        const token = r.data!.imageUrl.split("/").pop()!;
        const entry = store.peek(token)!;
        expect(existsSync(entry.path)).toBe(true);
    });

    it("file 关键词指定非图片课件被拒，提示用 download_learn_file", async () => {
        const skill = setup();
        const r = await exec(skill, {course: "数据结构", file: "第三章"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("不是图片");
    });

    it("多图无指定报 AMBIGUOUS 带候选", async () => {
        const client = {
            ...fakeClient,
            getFileList: async () => [makeFile("二维码A", "a.jpg"), makeFile("二维码B", "b.png")],
        };
        const skill = setup(client);
        const r = await exec(skill, {course: "数据结构"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("AMBIGUOUS");
        expect(r.error!.message).toContain("二维码A");
    });

    it("课程歧义/不存在走 resolveUniqueCourse 的错误", async () => {
        const skill = setup();
        expect((await exec(skill, {course: "不存在的课"})).error!.code).toBe("NOT_FOUND");
    });

    it("无图片通道（CLI/MCP）报 NOT_SUPPORTED；不需要确认", async () => {
        const skill = createShowLearnImageSkill(fakeClient);
        const r = await exec(skill, {course: "数据结构"});
        expect(r.error!.code).toBe("NOT_SUPPORTED");
        expect(skill.requiresConfirmation).toBeFalsy();
    });

    it("非法输入：course 缺失", async () => {
        const skill = setup();
        expect((await exec(skill, {})).error!.code).toBe("INVALID_INPUT");
    });
});

describe("show_learn_image 公告/作业正文内嵌图（假数据，无网络）", () => {
    const makeNotice = (title: string, content: string): Notification => ({
        id: `n-${title}`,
        title,
        content,
        hasRead: false,
        url: "",
        markedImportant: false,
        publishTime: new Date("2026-09-10T02:00:00Z"),
        publisher: "李老师",
        isFavorite: false,
    });

    const notices = [
        makeNotice("分组名单", `<p>名单见图：</p><img src="/upload/group.png"><p>群二维码：</p><img src="https://learn.tsinghua.edu.cn/upload/qr.jpg">`),
        makeNotice("纯文字公告", `<p>没有图片</p>`),
        makeNotice("名单补充说明", `<p>补一张</p><img src="/upload/extra.png">`),
    ];
    const homeworks = [
        {title: "上机作业", description: `<p>按下图连线：</p><img src="/upload/topo.jpg">`} as unknown as Homework,
    ];

    const inlineClient = {
        ...fakeClient,
        getNotifications: async () => notices,
        getHomeworkList: async () => homeworks,
    };

    it("notice 模式默认取第 1 张，相对路径解析为学堂绝对 URL", async () => {
        const skill = setup(inlineClient);
        const r = await exec(skill, {course: "数据结构", notice: "分组名单"});
        expect(r.success).toBe(true);
        expect(r.data!.title).toBe("分组名单（图片1）");
        // octet-stream 按 URL 扩展名 .png 归一化
        expect(r.data!.contentType).toBe("image/png");
        expect(r.data!.markdown).toBe(`![分组名单（图片1）](${r.data!.imageUrl})`);
    });

    it("notice 模式 index 指定第 2 张", async () => {
        const skill = setup(inlineClient);
        const r = await exec(skill, {course: "数据结构", notice: "分组名单", index: 2});
        expect(r.success).toBe(true);
        expect(r.data!.title).toBe("分组名单（图片2）");
        expect(r.data!.contentType).toBe("image/jpeg");
    });

    it("notice 公告无内嵌图 NOT_FOUND；index 越界 INVALID_INPUT", async () => {
        const skill = setup(inlineClient);
        const noImg = await exec(skill, {course: "数据结构", notice: "纯文字"});
        expect(noImg.error!.code).toBe("NOT_FOUND");
        expect(noImg.error!.message).toContain("没有内嵌图片");
        const outOfRange = await exec(skill, {course: "数据结构", notice: "分组名单", index: 3});
        expect(outOfRange.error!.code).toBe("INVALID_INPUT");
        expect(outOfRange.error!.message).toContain("只有 2 张");
    });

    it("notice 标题歧义报 AMBIGUOUS 带候选", async () => {
        const skill = setup(inlineClient);
        const r = await exec(skill, {course: "数据结构", notice: "名单"});
        expect(r.error!.code).toBe("AMBIGUOUS");
        expect(r.error!.message).toContain("名单补充说明");
    });

    it("homework 模式显示作业描述内嵌图", async () => {
        const skill = setup(inlineClient);
        const r = await exec(skill, {course: "数据结构", homework: "上机"});
        expect(r.success).toBe(true);
        expect(r.data!.title).toBe("上机作业（图片1）");
        expect(r.data!.contentType).toBe("image/jpeg");
    });

    it("file/notice/homework 互斥；index 非法被拒", async () => {
        const skill = setup(inlineClient);
        const both = await exec(skill, {course: "数据结构", file: "二维码", notice: "名单"});
        expect(both.error!.code).toBe("INVALID_INPUT");
        expect(both.error!.message).toContain("三选一");
        expect((await exec(skill, {course: "数据结构", notice: "分组名单", index: 0})).error!.code).toBe("INVALID_INPUT");
    });
});
