import {spawn} from "node:child_process";
import {readFileSync, rmSync, statSync} from "node:fs";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";

const script = fileURLToPath(new URL("../../.agents/skills/thu-agent/scripts/extract-images.mjs", import.meta.url));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0q8AAAAASUVORK5CYII=";
const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

function extract(result: unknown): Promise<{status: number | null; result: Record<string, any>}> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], {stdio: ["pipe", "pipe", "pipe"]});
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.on("error", reject);
        child.on("close", (status) => {
            try {
                const parsed = JSON.parse(stdout);
                if (parsed.success) directories.push(dirname(parsed.data.images[0].path));
                resolve({status, result: parsed});
            } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify(result));
    });
}

describe("Skill 图片桥", () => {
    it("将裸 base64 与 data URL 解码成可读的私有图片路径", async () => {
        const {status, result} = await extract({success: true, data: {note: "测试图", imagesBase64: [png, `data:image/png;base64,${png}`]}});
        expect(status).toBe(0);
        expect(result.data.images).toHaveLength(2);
        for (const image of result.data.images) {
            expect(image.mimeType).toBe("image/png");
            expect(readFileSync(image.path)).toEqual(Buffer.from(png, "base64"));
            if (process.platform !== "win32") expect(statSync(image.path).mode & 0o777).toBe(0o600);
        }
        expect(JSON.stringify(result)).not.toContain(png);
    });

    it("保留上游失败，不伪造图片或成绩", async () => {
        const upstream = {success: false, error: {code: "DORM_SCORE_UNAVAILABLE", message: "没有公示图"}};
        const {status, result} = await extract(upstream);
        expect(status).toBe(1);
        expect(result).toEqual(upstream);
        expect(directories).toHaveLength(0);
    });

    it("拒绝无图、非法 base64 和伪装的非图片内容", async () => {
        for (const imagesBase64 of [[], ["not-base64!"], [Buffer.from("<html>登录页</html>").toString("base64")], [png, "bad"]]) {
            const {status, result} = await extract({success: true, data: {imagesBase64}});
            expect(status).toBe(2);
            expect(result.error.code).toBe("IMAGE_EXTRACTION_FAILED");
        }
        expect(directories).toHaveLength(0);
    });
});
