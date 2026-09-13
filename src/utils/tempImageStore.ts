/**
 * TempImageStore —— 「对话内显示图片」的一次性临时文件登记处。
 *
 * 场景：清灵把邮件图片附件（如课程群二维码）直接显示在 Web 对话里。
 * 流程（本地前后保持一致，不留残余文件）：
 *   1. put()   技能把图片字节写到临时目录，拿到随机 token 与 URL（/api/temp-image/<token>）
 *   2. take()  Web 端点按 token 取出文件信息并注销（token 立即失效，不可二次取）
 *   3. 端点把文件流给浏览器后删除；若一直没人取（模型没把图片写进回复），
 *      TTL（默认 15 分钟）到点自动清理
 * token 是 randomUUID，URL 不暴露真实路径；取件即删保证「展示后本地无残留」。
 */
import {existsSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";

export interface TempImageEntry {
    token: string;
    path: string;
    contentType: string;
    filename: string;
}

interface Registered extends TempImageEntry {
    timer: NodeJS.Timeout;
}

/** contentType → 落盘扩展名（白名单，防止 contentType 注入奇怪后缀） */
const EXT_BY_TYPE: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
};

export class TempImageStore {
    private readonly entries = new Map<string, Registered>();

    /**
     * @param dir   临时文件目录（不存在时 put 自动创建）
     * @param ttlMs 没人取件时的自清理时限，默认 15 分钟
     */
    constructor(
        private readonly dir: string,
        private readonly ttlMs: number = 15 * 60_000,
    ) {}

    /** 写入临时文件并登记，返回 token 与对外 URL 路径 */
    put(content: Buffer, contentType: string, filename: string): {token: string; url: string} {
        mkdirSync(this.dir, {recursive: true});
        const token = randomUUID();
        const ext = EXT_BY_TYPE[contentType] ?? ".img";
        const path = join(this.dir, `${token}${ext}`);
        writeFileSync(path, content);
        const timer = setTimeout(() => this.evict(token), this.ttlMs);
        timer.unref?.();
        this.entries.set(token, {token, path, contentType, filename, timer});
        return {token, url: `/api/temp-image/${token}`};
    }

    /**
     * 取件消费：返回文件信息并立即注销 token（一次性）。
     * 调用方（Web 端点）负责把文件流给客户端后删文件；
     * 取走后 TTL 计时取消，清理责任移交给调用方。
     */
    take(token: string): TempImageEntry | undefined {
        const entry = this.entries.get(token);
        if (!entry) return undefined;
        clearTimeout(entry.timer);
        this.entries.delete(token);
        const {timer: _timer, ...rest} = entry;
        return rest;
    }

    /** 还有多少未取件（测试与排障用） */
    get pendingCount(): number {
        return this.entries.size;
    }

    /** 删文件 + 注销（TTL 到期或异常兜底） */
    private evict(token: string): void {
        const entry = this.entries.get(token);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.entries.delete(token);
        try {
            if (existsSync(entry.path)) rmSync(entry.path);
        } catch { /* 清理失败不致命，下次启动时目录仍在 */ }
    }
}

/** serve 完成后删除已取件的文件（端点与测试共用同一删除语义） */
export function removeServedImage(path: string): void {
    try {
        if (existsSync(path)) rmSync(path);
    } catch { /* 同上，不致命 */ }
}
