/**
 * preview_learn_file Skill 测试（假 client + 真实 TempImageStore + 临时下载目录，无网络）。
 */
import {mkdtempSync, rmSync, existsSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {CourseType, type CourseInfo, type File as LearnFile, type SemesterInfo} from "thu-learn-lib";
import {createPreviewLearnFileSkill, type PreviewLearnFileData} from "../../src/skills/learn/previewLearnFile";
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
const filesByCourse: Record<string, LearnFile[]> = {
    "course-30240163": [
        makeFile("第三章课件", "ch3.pdf"),
        makeFile("第四章课件", "ch4.pptx"),
        makeFile("课程群二维码", "qrcode.jpg"),
    ],
};

/** content-type 故意给 octet-stream，验证按扩展名定 content-type */
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
let downloadDir = "";
afterEach(() => {
    if (dir) rmSync(dir, {recursive: true, force: true});
    dir = "";
});

const setup = (client = fakeClient) => {
    dir = mkdtempSync(join(tmpdir(), "qingling-preview-test-"));
    store = new TempImageStore(join(dir, "tmp-images"));
    downloadDir = join(dir, "Downloads");
    return createPreviewLearnFileSkill(client, store);
};

const exec = async (skill: ReturnType<typeof setup>, input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: PreviewLearnFileData; error?: {code: string; message: string}};

describe("preview_learn_file Skill（假数据，无网络）", () => {
    it("PDF 课件：落盘到指定目录并登记预览 URL，markdown 带 file: 前缀", async () => {
        const skill = setup();
        const r = await exec(skill, {course: "数据结构", file: "第三章", saveDir: downloadDir});
        expect(r.success).toBe(true);
        expect(r.data!.title).toBe("第三章课件");
        const savedPath = join(downloadDir, "ch3.pdf");
        expect(r.data!.savedPath).toBe(savedPath);
        expect(readFileSync(savedPath, "utf8")).toBe("bytes of https://learn.tsinghua.edu.cn/download/ch3.pdf");
        expect(r.data!.markdown).toBe(`![file:ch3.pdf](${r.data!.fileUrl})`);
        // store 直接引用落盘文件（不复制临时副本），content-type 按扩展名
        const token = r.data!.fileUrl.split("/").pop()!;
        const entry = store.peek(token)!;
        expect(entry.path).toBe(savedPath);
        expect(entry.contentType).toBe("application/pdf");
        // 用户点「已用完」→ 删落盘文件
        expect(store.consume(token)).toBe(true);
        expect(existsSync(savedPath)).toBe(false);
    });

    it("PPTX 课件：按 pptx content-type 登记（前端走下载卡片）", async () => {
        const skill = setup();
        const r = await exec(skill, {course: "数据结构", file: "第四章", saveDir: downloadDir});
        expect(r.success).toBe(true);
        expect(r.data!.markdown).toContain("![file:ch4.pptx]");
        const token = r.data!.fileUrl.split("/").pop()!;
        expect(store.peek(token)!.contentType)
            .toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    });

    it("学堂文件名不带扩展名时按 fileType 判定并补扩展名（真实学堂行为）", async () => {
        // 学堂课件列表实测：title 和 remoteFile.name 都不带扩展名，扩展名在 fileType 字段
        const bare = makeFile("组成原理12-1 Instructions-thinpad", "组成原理12-1 Instructions-thinpad");
        bare.fileType = "pdf";
        const client = {...fakeClient, getFileList: async () => [bare]};
        const skill = setup(client);
        const r = await exec(skill, {course: "数据结构", file: "Instructions", saveDir: downloadDir});
        expect(r.success).toBe(true);
        expect(r.data!.savedPath).toBe(join(downloadDir, "组成原理12-1 Instructions-thinpad.pdf"));
        expect(r.data!.markdown).toContain("![file:组成原理12-1 Instructions-thinpad.pdf]");
        const token = r.data!.fileUrl.split("/").pop()!;
        expect(store.peek(token)!.contentType).toBe("application/pdf");
    });

    it("写操作需要确认（requiresConfirmation）", () => {
        const skill = setup();
        expect(skill.requiresConfirmation).toBe(true);
    });

    it("非 PDF/PPT 课件被拒，提示用 show_learn_image / download_learn_file", async () => {
        const skill = setup();
        const r = await exec(skill, {course: "数据结构", file: "二维码", saveDir: downloadDir});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("不是 PDF/PPT");
        expect(existsSync(downloadDir)).toBe(false); // 未落盘
    });

    it("文件名歧义/不存在走 matchLearnFile 的错误", async () => {
        const skill = setup();
        expect((await exec(skill, {course: "数据结构", file: "课件", saveDir: downloadDir})).error!.code).toBe("AMBIGUOUS");
        expect((await exec(skill, {course: "数据结构", file: "不存在的文件", saveDir: downloadDir})).error!.code).toBe("NOT_FOUND");
    });

    it("无预览通道（CLI/MCP）报 NOT_SUPPORTED", async () => {
        const skill = createPreviewLearnFileSkill(fakeClient);
        const r = await exec(skill, {course: "数据结构", file: "第三章", saveDir: downloadDir});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_SUPPORTED");
    });

    it("参数校验：course/file 必填非空，saveDir 必须是字符串", async () => {
        const skill = setup();
        expect((await exec(skill, {file: "第三章"})).error!.code).toBe("INVALID_INPUT");
        expect((await exec(skill, {course: "数据结构"})).error!.code).toBe("INVALID_INPUT");
        expect((await exec(skill, {course: "数据结构", file: "第三章", saveDir: 42})).error!.code).toBe("INVALID_INPUT");
    });
});
