/**
 * show_learn_image Skill 测试（假 client + 真实 TempImageStore 临时目录，无网络）。
 */
import {mkdtempSync, rmSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {CourseType, type CourseInfo, type File as LearnFile, type SemesterInfo} from "thu-learn-lib";
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
