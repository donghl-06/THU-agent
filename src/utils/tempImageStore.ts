/**
 * TempImageStore —— 「对话内显示图片/课件」的临时文件登记处。
 *
 * 场景：清灵把图片附件（邮件课程群二维码、学堂图片课件）直接显示在 Web 对话里，
 * 或把 PDF/PPT 课件下载落盘后在对话里给预览卡片（preview_learn_file）。
 * 生命周期（本地前后保持一致，不留残余文件）：
 *   1. put()      技能把图片字节写到临时目录，拿到随机 token 与 URL（/api/temp-image/<token>）
 *   register()    登记一个已落盘的文件（如「下载」目录里的课件），同样换 token 与 URL；
 *                 与 put 的差别：文件是用户资产，TTL 到点只注销 token（预览链接失效），
 *                 不删文件本身
 *   2. peek()     Web 端点按 token 取文件信息流给浏览器——不删除，
 *                 用户刷新历史、反复查看都还在
 *   3. consume()  用户点「已用完」按钮，确认使用完毕后才删本地文件并注销
 *                 （register 登记的用户文件也在这里删——这正是按钮的语义）
 *   兜底：用户一直不点，TTL（默认 15 分钟）到点自动清理（put 的删文件，register 的只注销）
 * token 是 randomUUID，URL 不暴露真实路径。
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
    /** true=store 自己写的临时副本（TTL 连文件一起清）；false=用户已落盘的文件（TTL 只注销 token） */
    owned: boolean;
}

/** contentType → 落盘扩展名（白名单，防止 contentType 注入奇怪后缀） */
const EXT_BY_TYPE: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    // 课件预览（preview_learn_file 走 register，不经过 put 的扩展名映射，这里仅兜底）
    "application/pdf": ".pdf",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

export class TempImageStore {
    private readonly entries = new Map<string, Registered>();

    /**
     * @param dir   临时文件目录（不存在时 put 自动创建）
     * @param ttlMs 未确认使用时的自清理时限，默认 15 分钟
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
        const timer = setTimeout(() => this.evict(token, true), this.ttlMs);
        timer.unref?.();
        this.entries.set(token, {token, path, contentType, filename, owned: true, timer});
        return {token, url: `/api/temp-image/${token}`};
    }

    /**
     * 登记一个已存在的文件（如 preview_learn_file 下载到「下载」目录的课件），
     * 换取对话内预览 URL。文件是用户资产：TTL 到点只注销 token（预览链接失效），
     * 不删文件；用户点「已用完」走 consume 才删。
     */
    register(path: string, contentType: string, filename: string): {token: string; url: string} {
        const token = randomUUID();
        const timer = setTimeout(() => this.evict(token, false), this.ttlMs);
        timer.unref?.();
        this.entries.set(token, {token, path, contentType, filename, owned: false, timer});
        return {token, url: `/api/temp-image/${token}`};
    }

    /** 查看条目（serve 用）：不注销、不删除，图片可反复展示 */
    peek(token: string): TempImageEntry | undefined {
        const entry = this.entries.get(token);
        if (!entry) return undefined;
        const {timer: _timer, owned: _owned, ...rest} = entry;
        return rest;
    }

    /**
     * 确认使用完毕：删本地文件并注销 token（register 登记的用户文件也在此删除）。
     * 返回 false 表示 token 不存在（已清理/从未有过），调用方按 404 处理。
     */
    consume(token: string): boolean {
        const entry = this.entries.get(token);
        if (!entry) return false;
        this.evict(token, true);
        return true;
    }

    /** 还有多少未清理（测试与排障用） */
    get pendingCount(): number {
        return this.entries.size;
    }

    /**
     * 注销 token；deleteFile 为 true 时连文件一起删。
     * consume 恒删文件；TTL 兜底按 owned 区分：put 的临时副本删，register 的用户文件保留。
     */
    private evict(token: string, deleteFile: boolean): void {
        const entry = this.entries.get(token);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.entries.delete(token);
        if (!deleteFile) return;
        try {
            if (existsSync(entry.path)) rmSync(entry.path);
        } catch { /* 清理失败不致命，TTL/重启还有兜底 */ }
    }
}
