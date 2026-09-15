import {describe, expect, it, vi} from "vitest";
import {ThuError} from "../../src/client/errors";
import type {SkillResult} from "../../src/skills/base/types";
import type {CloudDirent, CloudFile, CloudLibrary, CloudSearchResult} from "../../src/client/cloud/CloudClient";
import {createGetCloudDirectorySkill} from "../../src/skills/cloud/getCloudDirectory";
import {createGetCloudLibrariesSkill} from "../../src/skills/cloud/getCloudLibraries";
import {createSearchCloudFilesSkill} from "../../src/skills/cloud/searchCloudFiles";
import {createShowCloudFileSkill} from "../../src/skills/cloud/showCloudFile";
import type {ShowCloudFileData} from "../../src/skills/cloud/showCloudFile";
import type {CloudDirectoryData} from "../../src/skills/cloud/getCloudDirectory";

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

function makeClient() {
    return {
        listLibraries: vi.fn(async () => [library]),
        getDirectory: vi.fn(async () => directories),
        searchFiles: vi.fn(async () => searchResults),
        getFileDetail: vi.fn(async () => recording),
        getFileDownloadUrl: vi.fn(async () => "https://cloud.tsinghua.edu.cn/seafhttp/files/token/2025010550.mp4"),
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
});
