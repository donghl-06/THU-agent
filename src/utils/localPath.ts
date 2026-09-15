/**
 * 用户给出的本地路径解析。
 *
 * 模型/用户在对话里给的路径五花八门，直接当 Linux 路径用会静默写错地方
 * （2026-09-13 实测：saveDir="~/Desktop" 在项目目录下建出了字面 "~" 目录，
 *  "D:\大学\..." 被当成了一个合法但莫名其妙的文件名）。统一在这里归一：
 *   - "~" / "~/..."            → 用户主目录
 *   - "D:\..." / "D:/..."      → WSL 下翻译成 /mnt/d/...（盘符挂载存在时）
 *   - 其余                     → 原样（相对路径按进程 CWD，保持 Node 语义）
 */
import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {execSync} from "node:child_process";

const DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/;

/** WSL 标志：Linux 且 /mnt 下挂着 Windows 盘 */
function isWsl(): boolean {
    return process.platform === "linux" && existsSync("/mnt/c");
}

/** Windows 盘符路径 → WSL 挂载路径。盘未挂载时返回 undefined */
function driveToWsl(drive: string, rest: string): string | undefined {
    const mount = `/mnt/${drive.toLowerCase()}`;
    if (!existsSync(mount)) return undefined;
    return `${mount}/${rest.replaceAll("\\", "/")}`;
}

export type ResolvePathResult =
    | {ok: true; path: string; /** 发生了翻译时给用户看的说明（如 D:\ → /mnt/d/） */ note?: string}
    | {ok: false; error: string};

/**
 * 归一化用户输入的路径。不存在/不可用不在这里检查（读/写各有语义），
 * 只做语法层的展开与翻译。
 */
export function resolveUserPath(input: string): ResolvePathResult {
    const trimmed = input.trim();
    if (!trimmed) return {ok: false, error: "路径不能为空"};

    if (trimmed === "~" || trimmed.startsWith("~/")) {
        return {ok: true, path: trimmed === "~" ? homedir() : homedir() + trimmed.slice(1)};
    }

    const drive = DRIVE_PATH.exec(trimmed);
    if (drive) {
        if (!isWsl()) {
            return {
                ok: false,
                error: `「${trimmed}」是 Windows 路径，但清灵运行在 ${process.platform} 上，无法访问。`,
            };
        }
        const translated = driveToWsl(drive[1], drive[2]);
        if (!translated) {
            return {
                ok: false,
                error: `找不到 ${drive[1].toUpperCase()}: 盘的 WSL 挂载（/mnt/${drive[1].toLowerCase()}），` +
                    `请确认该盘存在，或改用 /mnt/${drive[1].toLowerCase()}/... 形式的路径。`,
            };
        }
        return {
            ok: true,
            path: translated,
            note: `Windows 路径已按 WSL 挂载翻译为 ${translated}`,
        };
    }

    return {ok: true, path: trimmed};
}

let cachedWindowsDownloads: string | undefined;

/**
 * 下载的默认保存目录。
 * WSL 下优先用 Windows 的「下载」文件夹（用户在 Windows 资源管理器里直接可见），
 * 其次 ~/Downloads，最后主目录。结果进程内缓存。
 */
export function defaultDownloadDir(): string {
    cachedWindowsDownloads ??= detectWindowsDownloads() ?? fallbackDownloadDir();
    return cachedWindowsDownloads;
}

function fallbackDownloadDir(): string {
    const downloads = `${homedir()}/Downloads`;
    return existsSync(downloads) ? downloads : homedir();
}

/** 通过 WSL interop 问 Windows 的用户目录；失败（非 WSL / interop 被关）返回 null */
function detectWindowsDownloads(): string | null {
    if (!isWsl()) return null;
    try {
        const profile = execSync('cmd.exe /c "echo %USERPROFILE%"', {
            encoding: "utf8",
            timeout: 3000,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim(); // 形如 C:\Users\dongh_o
        const m = DRIVE_PATH.exec(profile);
        if (!m) return null;
        const downloads = driveToWsl(m[1], `${m[2]}/Downloads`);
        return downloads && existsSync(downloads) ? downloads : null;
    } catch {
        return null;
    }
}
