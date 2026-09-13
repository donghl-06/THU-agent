/**
 * 清灵的本机稳定设备指纹。
 *
 * 清华认证把 fingerprint 视为设备标识；如果每次登录都随机生成，同一个安装
 * 会被注册成一串“信任设备”。这里把指纹持久化到用户本地数据目录，并允许
 * THU_FINGERPRINT 作为开发者/特殊部署时的显式覆盖。
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import {randomUUID} from "node:crypto";

const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/i;

export function stableFingerprintPath(): string {
    if (process.env.QINGLING_DEVICE_FILE) return process.env.QINGLING_DEVICE_FILE;

    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
        return join(process.env.LOCALAPPDATA, "QingLing", "device.json");
    }
    if (process.platform === "darwin") {
        return join(
            process.env.XDG_STATE_HOME ?? join(homedir(), "Library", "Application Support"),
            "QingLing",
            "device.json",
        );
    }
    return join(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
        "QingLing",
        "device.json",
    );
}

/**
 * Resolve the fingerprint once. Explicit values (credentials and environment)
 * win; otherwise the first caller atomically creates the shared local file.
 *
 * `wx` matters when Web and MCP happen to start at the same time: two processes
 * can both see no file, but only one can create it. The loser re-reads the
 * winner's value instead of registering another trusted device.
 */
export function resolveStableFingerprint(explicit?: string, file = stableFingerprintPath()): string {
    const override = (explicit ?? process.env.THU_FINGERPRINT ?? "").trim();
    if (override) {
        if (!FINGERPRINT_PATTERN.test(override)) {
            throw new Error("THU_FINGERPRINT 必须是 32 位十六进制字符串。");
        }
        return override.toLowerCase();
    }

    for (let attempt = 0; attempt < 3; attempt++) {
        if (existsSync(file)) {
            const saved = readStoredFingerprint(file);
            if (saved) return saved;
            throw new Error(`清灵设备指纹文件格式无效：${file}。请删除该文件后重试。`);
        }

        mkdirSync(dirname(file), {recursive: true});
        const fingerprint = randomUUID().replace(/-/g, "");
        try {
            writeFileSync(file, `${JSON.stringify({
                version: 1,
                fingerprint,
                createdAt: new Date().toISOString(),
            }, null, 2)}\n`, {flag: "wx", mode: 0o600});
            return fingerprint;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            // Another QingLing process just created the file. Read its value.
        }
    }
    throw new Error(`无法确定清灵设备指纹：${file}`);
}

function readStoredFingerprint(file: string): string | undefined {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as {fingerprint?: unknown};
        const fingerprint = typeof parsed.fingerprint === "string" ? parsed.fingerprint.trim() : "";
        return FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint.toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}
