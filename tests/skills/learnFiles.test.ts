/**
 * get_learn_files / download_learn_file Skill 测试（假 client + 临时目录，无网络）。
 */
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {CourseType, type CourseInfo, type File as LearnFile, type SemesterInfo} from "thu-learn-lib";
import {createGetLearnFilesSkill, type LearnFilesData} from "../../src/skills/learn/getLearnFiles";
import {createDownloadLearnFileSkill, type DownloadLearnFileData} from "../../src/skills/learn/downloadLearnFile";

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

const makeFile = (title: string, uploadTime: string, category?: string): LearnFile => ({
    id: `f-${title}`,
    fileId: `fid-${title}`,
    ...(category ? {category: {id: `cat-${category}`, title: category, creationTime: new Date("2026-01-01")}} : {}),
    rawSize: 1024,
    size: "1K",
    title,
    description: "",
    uploadTime: new Date(uploadTime),
    publishTime: new Date(uploadTime),
    downloadUrl: `https://learn.tsinghua.edu.cn/download/${title}`,
    previewUrl: "",
    isNew: false,
    markedImportant: false,
    visitCount: 0,
    downloadCount: 0,
    fileType: "pdf",
    remoteFile: {
        id: `rf-${title}`,
        name: `${title}.pdf`,
        downloadUrl: `https://learn.tsinghua.edu.cn/download/${title}`,
        previewUrl: "",
        size: "1K",
    },
});

const courses = [makeCourse("数据结构", "30240163"), makeCourse("大学物理B(1)", "10430484")];

const filesByCourse: Record<string, LearnFile[]> = {
    "course-30240163": [
        makeFile("第三章课件", "2026-09-10T02:00:00Z", "课件"),
        makeFile("第二章课件", "2026-09-01T02:00:00Z", "课件"),
    ],
    "course-10430484": [makeFile("实验指导书", "2026-09-05T02:00:00Z")],
};

const fakeClient = {
    getCurrentSemester: async () => fakeSemester,
    getCourses: async () => courses,
    getFileList: async (courseId: string) => filesByCourse[courseId] ?? [],
    downloadFile: async (url: string) => ({
        buffer: Buffer.from(`fake content of ${url}`),
        filename: undefined,
        contentType: "application/pdf",
    }),
};

const listSkill = createGetLearnFilesSkill(fakeClient);
const downloadSkill = createDownloadLearnFileSkill(fakeClient);

const execList = async (input?: unknown) =>
    (await listSkill.execute(input)) as {success: boolean; data?: LearnFilesData; error?: {code: string; message: string}};
const execDownload = async (input?: unknown) =>
    (await downloadSkill.execute(input)) as {success: boolean; data?: DownloadLearnFileData; error?: {code: string; message: string}};

let dir = "";

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "qingling-learn-dl-"));
});

afterAll(async () => {
    await rm(dir, {recursive: true, force: true});
});

describe("get_learn_files Skill（假数据，无网络）", () => {
    it("聚合全部课程并按上传时间倒序", async () => {
        const r = await execList();
        expect(r.success).toBe(true);
        expect(r.data!.count).toBe(3);
        expect(r.data!.files.map((f) => f.title)).toEqual(["第三章课件", "实验指导书", "第二章课件"]);
        expect(r.data!.files[0]).toMatchObject({course: "数据结构", category: "课件", fileType: "pdf"});
        expect(r.data!.files[0].uploadTime).toBe("2026-09-10 10:00");
    });

    it("course 与 keyword 过滤", async () => {
        let r = await execList({course: "数据结构", keyword: "第二章"});
        expect(r.data!.count).toBe(1);
        expect(r.data!.files[0].title).toBe("第二章课件");
        r = await execList({keyword: "不存在的文件"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
    });

    it("非法输入校验", async () => {
        const r = await execList({limit: -1});
        expect(r.error!.code).toBe("INVALID_INPUT");
    });
});

describe("download_learn_file Skill（假 client + 临时目录）", () => {
    it("成功下载：内容写入 saveDir 下的文件名", async () => {
        const r = await execDownload({course: "数据结构", file: "第三章", saveDir: dir});
        expect(r.success).toBe(true);
        expect(r.data!.savedPath).toBe(join(dir, "第三章课件.pdf"));
        expect(r.data!.sizeBytes).toBeGreaterThan(0);
        const content = await readFile(r.data!.savedPath, "utf8");
        expect(content).toContain("fake content");
        expect(r.data!.message).toContain("数据结构");
    });

    it("课程歧义 / 文件歧义 / 文件不存在", async () => {
        // 课程歧义用独立 fixture（共享 fixture 里两门课没有公共关键词）
        const ambiguousClient = {
            ...fakeClient,
            getCourses: async () => [
                makeCourse("高等数学A(1)", "10421055"),
                makeCourse("高等数学A(2)", "10421065"),
            ],
        };
        const ambiguousSkill = createDownloadLearnFileSkill(ambiguousClient);
        let r = (await ambiguousSkill.execute({course: "高等数学", file: "第三章", saveDir: dir})) as Awaited<ReturnType<typeof execDownload>>;
        expect(r.error!.code).toBe("AMBIGUOUS");
        r = await execDownload({course: "数据结构", file: "课件", saveDir: dir});
        expect(r.error!.code).toBe("AMBIGUOUS");
        expect(r.error!.message).toContain("第二章课件");
        r = await execDownload({course: "数据结构", file: "第十章", saveDir: dir});
        expect(r.error!.code).toBe("NOT_FOUND");
    });

    it("必填参数缺失被拒", async () => {
        const r = await execDownload({course: "数据结构"});
        expect(r.error!.code).toBe("INVALID_INPUT");
    });

    it("requiresConfirmation 标记为 true", () => {
        expect(downloadSkill.requiresConfirmation).toBe(true);
    });
});
