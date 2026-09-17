import {describe, expect, it, vi} from "vitest";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ThuError} from "../../src/client/errors";
import type {SkillResult} from "../../src/skills/base/types";
import type {
    CloudDirent,
    CloudFile,
    CloudLibrary,
    CloudShareLink,
    CloudSearchResult,
    CloudUploadFile,
} from "../../src/client/cloud/CloudClient";
import {multipartUploadBody, normalizeUploadResponse} from "../../src/client/cloud/CloudClient";
import {createGetCloudDirectorySkill} from "../../src/skills/cloud/getCloudDirectory";
import {createGetCloudLibrariesSkill} from "../../src/skills/cloud/getCloudLibraries";
import {createSearchCloudFilesSkill} from "../../src/skills/cloud/searchCloudFiles";
import {createShowCloudFileSkill} from "../../src/skills/cloud/showCloudFile";
import type {ShowCloudFileData} from "../../src/skills/cloud/showCloudFile";
import type {CloudDirectoryData} from "../../src/skills/cloud/getCloudDirectory";
import {createUploadCloudFileSkill} from "../../src/skills/cloud/uploadCloudFile";
import {defaultLocalCloudFileLoader} from "../../src/skills/cloud/uploadCloudFile";
import {createCreateCloudFolderSkill} from "../../src/skills/cloud/createCloudFolder";
import {createRenameCloudItemSkill} from "../../src/skills/cloud/renameCloudItem";
import {createTransferCloudItemSkill} from "../../src/skills/cloud/transferCloudItem";
import {createDeleteCloudItemSkill} from "../../src/skills/cloud/deleteCloudItem";
import {createCloudShareLinkSkill} from "../../src/skills/cloud/createCloudShareLink";

const library: CloudLibrary = {
    id: "repo-1",
    name: "学习资料",
    type: "mine",
    ownerName: "清灵",
    sizeBytes: 1024,
    modifiedAt: "2026-09-15T08:00:00.000Z",
    permission: "rw",
    encrypted: false,
};

const directories: CloudDirent[] = [
    {name: "课件", type: "dir", path: "/课件", sizeBytes: null, modifiedAt: null, permission: "rw"},
    {name: "outline.pdf", type: "file", path: "/outline.pdf", sizeBytes: 2048, modifiedAt: null, permission: "rw"},
];

const recording: CloudFile = {
    repoId: "repo-1",
    path: "/2025010550.mp4",
    name: "2025010550.mp4",
    sizeBytes: 258 * 1024 * 1024,
    modifiedAt: "2026-07-20T08:00:00.000Z",
    permission: "rw",
    canPreview: true,
};

const shareLink: CloudShareLink = {
    token: "share-token",
    url: "https://cloud.tsinghua.edu.cn/d/share-token/",
    downloadUrl: null,
    libraryId: "repo-1",
    libraryName: "学习资料",
    path: "/outline.pdf",
    objectName: "outline.pdf",
    isDirectory: false,
    expiresAt: null,
    isExpired: false,
};

const searchResults: CloudSearchResult[] = [
    {
        name: "数据结构.pdf",
        path: "/课件/数据结构.pdf",
        repoId: "repo-1",
        repoName: "学习资料",
        isFile: true,
        sizeBytes: 4096,
        modifiedAt: null,
    },
];

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = "";
    for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        result += decoder.decode(value, {stream: true});
    }
    return result + decoder.decode();
}

function makeClient() {
    return {
        listLibraries: vi.fn(async () => [library]),
        getDirectory: vi.fn(async () => directories),
        searchFiles: vi.fn(async () => searchResults),
        getFileDetail: vi.fn(async () => recording),
        getFileDownloadUrl: vi.fn(async () => "https://cloud.tsinghua.edu.cn/seafhttp/files/token/2025010550.mp4"),
        uploadFile: vi.fn(async () => [{name: "上传文件.pdf"}]),
        createFolder: vi.fn(async (_repoId: string, path: string) => path),
        renameDirent: vi.fn(async (
            _repoId: string,
            _path: string,
            _type: CloudDirent["type"],
            newName: string,
        ) => `/课件/${newName}`),
        deleteDirent: vi.fn(async () => undefined),
        transferDirent: vi.fn(async () => [{obj_name: "outline.pdf"}]),
        createShareLink: vi.fn(async (
            _repoId: string,
            path: string,
            options?: {expireDays?: number},
        ) => ({
            ...shareLink,
            path,
            objectName: path.split("/").filter(Boolean).pop() ?? "",
            isDirectory: path === "/课件",
            expiresAt: options?.expireDays === 7
                ? "2026-09-22T00:00:00.000Z"
                : null,
        })),
    };
}

describe("cloud skills", () => {
    it("lists read-only cloud libraries", async () => {
        const client = makeClient();
        const result = await createGetCloudLibrariesSkill(client).execute({});

        expect(result.success).toBe(true);
        expect(result.data).toEqual({total: 1, truncated: false, libraries: [library]});
    });

    it("resolves a cloud directory by unique library name and normalizes the path", async () => {
        const client = makeClient();
        const result = await createGetCloudDirectorySkill(client).execute({
            library: "学习资料",
            path: "课件/",
        });

        expect(result.success).toBe(true);
        expect(client.getDirectory).toHaveBeenCalledWith("repo-1", "/课件");
        expect((result.data as CloudDirectoryData).entries).toEqual(directories);
    });

    it("supports a cloud library id directly", async () => {
        const client = makeClient();
        const result = await createGetCloudDirectorySkill(client).execute({library: "repo-1"});

        expect(result.success).toBe(true);
        expect(client.getDirectory).toHaveBeenCalledWith("repo-1", "/");
    });

    it("rejects invalid cloud directory input", async () => {
        const client = makeClient();
        const skill = createGetCloudDirectorySkill(client);
        const missing = await skill.execute({});
        const traversal = await skill.execute({library: "学习资料", path: "/../secret"});

        expect(missing.success).toBe(false);
        expect(missing.error!.code).toBe("INVALID_INPUT");
        expect(traversal.success).toBe(false);
        expect(traversal.error!.code).toBe("INVALID_INPUT");
        expect(client.getDirectory).not.toHaveBeenCalled();
    });

    it("reports ambiguity and missing cloud libraries", async () => {
        const ambiguous = {...library, id: "repo-2"};
        const client = makeClient();
        client.listLibraries.mockResolvedValue([library, ambiguous]);
        const result = await createGetCloudDirectorySkill(client).execute({library: "学习资料"});

        expect(result.success).toBe(false);
        expect(result.error!.code).toBe("AMBIGUOUS");

        client.listLibraries.mockResolvedValue([]);
        const missing = await createGetCloudDirectorySkill(client).execute({library: "不存在"});
        expect(missing.error!.code).toBe("NOT_FOUND");
    });

    it("searches cloud files with input validation", async () => {
        const client = makeClient();
        const skill = createSearchCloudFilesSkill(client);
        const result = await skill.execute({keyword: "数据结构", limit: 1});
        const invalid = await skill.execute({keyword: " ", limit: 51});

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
            keyword: "数据结构",
            total: 1,
            truncated: false,
            results: searchResults,
        });
        expect(invalid.success).toBe(false);
        expect(invalid.error!.code).toBe("INVALID_INPUT");
    });

    it("normalizes ThuError to skill failure without exposing credentials", async () => {
        const client = makeClient();
        client.searchFiles.mockRejectedValue(new ThuError("AUTH_REQUIRED", "需要先完成统一身份认证"));
        const result = await createSearchCloudFilesSkill(client).execute({keyword: "x"});

        expect(result.success).toBe(false);
        expect(result.error).toEqual({code: "AUTH_REQUIRED", message: "需要先完成统一身份认证"});
    });

    it("opens a cloud video with a streamable media message", async () => {
        const client = makeClient();
        const result = await createShowCloudFileSkill(client).execute({
            library: "学习资料",
            path: "/2025010550.mp4",
        }) as SkillResult<ShowCloudFileData>;

        expect(result.success).toBe(true);
        expect(client.getFileDetail).toHaveBeenCalledWith("repo-1", "/2025010550.mp4");
        expect(client.getFileDownloadUrl).toHaveBeenCalledWith("repo-1", "/2025010550.mp4");
        expect(result.data?.markdown).toContain("![video:2025010550.mp4]");
        expect(result.data?.markdown).toContain("https://cloud.tsinghua.edu.cn/seafhttp/files/");
    });

    it("resolves a cloud file by keyword and returns a download message for ordinary files", async () => {
        const client = makeClient();
        client.searchFiles.mockResolvedValue([{
            ...searchResults[0],
            name: "outline.pdf",
            path: "/outline.pdf",
        }]);
        const pdf = {...recording, path: "/outline.pdf", name: "outline.pdf", sizeBytes: 2048};
        client.getFileDetail.mockResolvedValue(pdf);

        const result = await createShowCloudFileSkill(client).execute({
            library: "学习资料",
            file: "outline.pdf",
        }) as SkillResult<ShowCloudFileData>;

        expect(result.success).toBe(true);
        expect(client.searchFiles).toHaveBeenCalledWith("outline.pdf");
        expect(result.data?.mediaType).toBe("file");
        expect(result.data?.markdown).toContain("[下载「outline.pdf」]");
    });

    it("validates cloud file opening input", async () => {
        const client = makeClient();
        const skill = createShowCloudFileSkill(client);
        const neither = await skill.execute({library: "学习资料"});
        const both = await skill.execute({library: "学习资料", path: "/a.mp4", file: "a"});
        const traversal = await skill.execute({library: "学习资料", path: "/../a.mp4"});

        expect(neither.success).toBe(false);
        expect(both.success).toBe(false);
        expect(traversal.success).toBe(false);
        expect(client.getFileDownloadUrl).not.toHaveBeenCalled();
    });

    it("marks all cloud write operations as requiring confirmation", () => {
        const client = makeClient();
        const skills = [
            createUploadCloudFileSkill(client),
            createCreateCloudFolderSkill(client),
            createRenameCloudItemSkill(client),
            createTransferCloudItemSkill(client),
            createDeleteCloudItemSkill(client),
            createCloudShareLinkSkill(client),
        ];

        expect(skills.map((skill) => skill.requiresConfirmation))
            .toEqual([true, true, true, true, true, true]);
    });

    it("uploads a local file to a resolved cloud folder", async () => {
        const client = makeClient();
        const file: CloudUploadFile = {
            name: "上传文件.pdf",
            sizeBytes: 2048,
            content: new Blob(["demo"]),
        };
        const result = await createUploadCloudFileSkill(client, async () => file).execute({
            localFilePath: "D:/tmp/附件.pdf",
            library: "学习资料",
            folder: "课件/",
        });

        expect(result.success).toBe(true);
        expect(client.uploadFile).toHaveBeenCalledWith("repo-1", "/课件", file);
        expect(result.data).toMatchObject({
            cloudPath: "/课件/上传文件.pdf",
            sizeBytes: 2048,
        });
    });

    it("loads a real local file as a streaming upload blob", async () => {
        const dir = await mkdtemp(join(tmpdir(), "qingling-cloud-"));
        try {
            const path = join(dir, "附件.txt");
            await writeFile(path, "hello cloud", "utf8");
            const file = await defaultLocalCloudFileLoader(path, "云盘附件.txt");
            const stream = file.content;
            if (!(stream instanceof ReadableStream)) throw new Error("默认上传内容应当是流");
            const content = await streamText(stream);

            expect(file).toMatchObject({name: "云盘附件.txt", sizeBytes: 11});
            expect(content).toBe("hello cloud");
        } finally {
            await rm(dir, {recursive: true, force: true});
        }
    });

    it("builds multipart upload bodies without buffering the whole file", async () => {
        const upload = multipartUploadBody("/课件", {
            name: "附件.txt",
            sizeBytes: 5,
            content: new Blob(["hello"]),
        });
        const body = await streamText(upload.body);
        const boundary = upload.contentType.split("boundary=")[1];

        expect(upload.contentType).toMatch(/^multipart\/form-data; boundary=----QingLing/);
        expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
        expect(body).toContain('name="parent_dir"\r\n\r\n/课件\r\n');
        expect(body).toContain('name="file"; filename="附件.txt"');
        expect(body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    });

    it("accepts Seafile upload success responses even when the body is not JSON", () => {
        const file = {name: "图片.png", sizeBytes: 1, content: new Blob(["x"])};
        const emptyBody = normalizeUploadResponse(200, "", file);
        const textBody = normalizeUploadResponse(200, "uploaded", file);

        expect(emptyBody).toEqual([{name: "图片.png", response: ""}]);
        expect(textBody).toEqual([{name: "图片.png", response: "uploaded"}]);
        expect(() => normalizeUploadResponse(500, "{}", file)).toThrow(ThuError);
    });

    it("creates a cloud folder with recursive parent creation", async () => {
        const client = makeClient();
        const result = await createCreateCloudFolderSkill(client).execute({
            library: "repo-1",
            path: "课件/大三上",
        });

        expect(result.success).toBe(true);
        expect(client.createFolder).toHaveBeenCalledWith("repo-1", "/课件/大三上");
        expect(result.data).toMatchObject({path: "/课件/大三上"});
    });

    it("renames a resolved cloud file", async () => {
        const client = makeClient();
        const result = await createRenameCloudItemSkill(client).execute({
            library: "学习资料",
            path: "/outline.pdf",
            newName: "课程大纲.pdf",
        });

        expect(result.success).toBe(true);
        expect(client.renameDirent).toHaveBeenCalledWith(
            "repo-1",
            "/outline.pdf",
            "file",
            "课程大纲.pdf",
        );
        expect(result.data).toMatchObject({newPath: "/课件/课程大纲.pdf"});
    });

    it("reports server-side duplicate renaming instead of inventing a path", async () => {
        const client = makeClient();
        client.createFolder.mockResolvedValue("/课件/QingLing(1)");
        client.renameDirent.mockResolvedValue("/课程大纲(1).pdf");

        const folder = await createCreateCloudFolderSkill(client).execute({
            library: "学习资料",
            path: "/课件/QingLing",
        });
        const renamed = await createRenameCloudItemSkill(client).execute({
            library: "学习资料",
            path: "/outline.pdf",
            newName: "课程大纲.pdf",
        });

        expect(folder.data).toMatchObject({path: "/课件/QingLing(1)"});
        expect(renamed.data).toMatchObject({newPath: "/课程大纲(1).pdf"});
    });

    it("copies or moves a cloud item between folders", async () => {
        const client = makeClient();
        const move = await createTransferCloudItemSkill(client).execute({
            operation: "move",
            library: "学习资料",
            path: "/outline.pdf",
            destinationFolder: "/课件",
        });
        const copy = await createTransferCloudItemSkill(client).execute({
            operation: "copy",
            library: "学习资料",
            path: "/outline.pdf",
            destinationFolder: "/课件",
        });

        expect(move.success).toBe(true);
        expect(copy.success).toBe(true);
        expect(client.transferDirent).toHaveBeenCalledWith(
            "repo-1",
            "/",
            "outline.pdf",
            "repo-1",
            "/课件",
            "move",
        );
        expect(client.transferDirent).toHaveBeenCalledWith(
            "repo-1",
            "/",
            "outline.pdf",
            "repo-1",
            "/课件",
            "copy",
        );
    });

    it("deletes a resolved cloud item and reports recycle-bin guidance", async () => {
        const client = makeClient();
        const file = await createDeleteCloudItemSkill(client).execute({
            library: "学习资料",
            path: "/outline.pdf",
        });
        const folder = await createDeleteCloudItemSkill(client).execute({
            library: "学习资料",
            path: "/课件",
        });

        expect(file.success).toBe(true);
        expect(folder.success).toBe(true);
        expect(client.deleteDirent).toHaveBeenCalledWith("repo-1", "/outline.pdf", "file");
        expect(client.deleteDirent).toHaveBeenCalledWith("repo-1", "/课件", "dir");
    });

    it("creates confirmed read-only share links for files and folders", async () => {
        const client = makeClient();
        const file = await createCloudShareLinkSkill(client).execute({
            library: "学习资料",
            path: "/outline.pdf",
            expireDays: 7,
        });
        const folder = await createCloudShareLinkSkill(client).execute({
            library: "repo-1",
            path: "课件",
        });

        expect(file.success).toBe(true);
        expect(folder.success).toBe(true);
        expect(client.createShareLink).toHaveBeenCalledWith("repo-1", "/outline.pdf", {expireDays: 7});
        expect(client.createShareLink).toHaveBeenCalledWith("repo-1", "/课件", undefined);
        expect(file.data).toMatchObject({
            type: "file",
            shareLink: {
                url: "https://cloud.tsinghua.edu.cn/d/share-token/",
                expiresAt: "2026-09-22T00:00:00.000Z",
            },
        });
        expect(folder.data).toMatchObject({type: "dir", shareLink: {isDirectory: true}});
    });

    it("validates share-link paths and expiry input before resolving objects", async () => {
        const client = makeClient();
        const skill = createCloudShareLinkSkill(client);
        const root = await skill.execute({library: "学习资料", path: "/"});
        const zeroDays = await skill.execute({library: "学习资料", path: "/outline.pdf", expireDays: 0});
        const fractional = await skill.execute({
            library: "学习资料",
            path: "/outline.pdf",
            expireDays: 1.5,
        });
        client.getDirectory.mockResolvedValue([]);
        const missing = await skill.execute({library: "学习资料", path: "/不存在.pdf"});

        expect(root.error?.code).toBe("INVALID_INPUT");
        expect(zeroDays.error?.code).toBe("INVALID_INPUT");
        expect(fractional.error?.code).toBe("INVALID_INPUT");
        expect(missing.error?.code).toBe("NOT_FOUND");
        expect(client.createShareLink).not.toHaveBeenCalled();
    });

    it("rejects unsafe cloud write paths and names", async () => {
        const client = makeClient();
        const upload = createUploadCloudFileSkill(client, async () => ({
            name: "a.pdf",
            sizeBytes: 1,
            content: new Blob(["a"]),
        }));
        const folder = createCreateCloudFolderSkill(client);
        const rename = createRenameCloudItemSkill(client);
        const del = createDeleteCloudItemSkill(client);

        const traversal = await folder.execute({library: "学习资料", path: "/../secret"});
        const root = await del.execute({library: "学习资料", path: "/"});
        const pathName = await rename.execute({
            library: "学习资料",
            path: "/outline.pdf",
            newName: "a/b.pdf",
        });
        const uploadName = await upload.execute({
            localFilePath: "D:/tmp/a.pdf",
            library: "学习资料",
            targetName: "a/b.pdf",
        });

        expect(traversal.success).toBe(false);
        expect(root.success).toBe(false);
        expect(pathName.success).toBe(false);
        expect(uploadName.success).toBe(false);
        expect(client.createFolder).not.toHaveBeenCalled();
        expect(client.deleteDirent).not.toHaveBeenCalled();
        expect(client.renameDirent).not.toHaveBeenCalled();
        expect(client.uploadFile).not.toHaveBeenCalled();
    });
});
