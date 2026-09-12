/**
 * LearnClient —— Agent 项目与 thu-learn-lib（网络学堂）之间的统一适配层。
 *
 * 职责对标 ThuClient：
 *   - Learn2018Helper 生命周期与登录（凭证 + 稳定设备指纹，复用已信任设备免 2FA）
 *   - 二次认证兜底：学堂 SSO 报 DOUBLE_AUTH 时，先走 ensureDeviceTrusted 回调
 *    （即 ThuClient.login，完成 2FA 并信任本设备）再重试一次
 *   - 课程/学期元数据缓存、错误归一化
 *   - 文件下载走独立的下载会话（downloadSession.ts，lib 的 cookie jar 不对外开放）
 *
 * 非职责：课程名模糊匹配、输出裁剪 —— 那是 Skill 层的事。
 */
import {
    Learn2018Helper,
    type CalendarEvent,
    type CourseInfo,
    type File as LearnFile,
    type Homework,
    type Notification,
    type SemesterInfo,
} from "thu-learn-lib";
import {ThuError} from "../errors";
import {normalizeLearnError} from "./errors";
import {LearnDownloadSession, type LearnCredentials} from "./downloadSession";

/** 课程列表缓存 TTL：选课一周内可能变动，缓存 10 分钟 */
const COURSE_CACHE_TTL_MS = 10 * 60 * 1000;

export interface LearnClientOptions {
    credentials: LearnCredentials;
    /**
     * 二次认证兜底回调：学堂登录报需要 2FA 时调用一次（通常就是 ThuClient.login，
     * 它会走 2FA 交互并把本设备登记为信任设备），随后自动重试学堂登录。
     */
    ensureDeviceTrusted?: () => Promise<void>;
}

export class LearnClient {
    private readonly helper: Learn2018Helper;
    private readonly downloads: LearnDownloadSession;
    private readonly ensureDeviceTrusted?: () => Promise<void>;
    /** 本次进程是否已做过 2FA 兜底（避免每堂课都触发一次完整登录） */
    private trustAttempted = false;
    private readonly courseCache = new Map<string, {value: CourseInfo[]; expireAt: number}>();
    private semesterCache?: {value: SemesterInfo; expireAt: number};

    constructor(opts: LearnClientOptions) {
        const {username, password, fingerprint} = opts.credentials;
        this.ensureDeviceTrusted = opts.ensureDeviceTrusted;
        this.helper = new Learn2018Helper({
            provider: () => ({username, password, fingerPrint: fingerprint}),
        });
        this.downloads = new LearnDownloadSession(opts.credentials);
    }

    /**
     * 统一调用入口：错误归一化 + 2FA 兜底重试一次。
     * （lib 内部会自动登录/会话过期重登，这里只补它解决不了的设备信任场景）
     */
    private async call<T>(fn: (helper: Learn2018Helper) => Promise<T>): Promise<T> {
        try {
            return await fn(this.helper);
        } catch (e) {
            const err = normalizeLearnError(e);
            if (err.code === "AUTH_REQUIRED" && !this.trustAttempted && this.ensureDeviceTrusted) {
                this.trustAttempted = true;
                await this.ensureDeviceTrusted(); // 失败会直接向上抛 ThuError
                try {
                    return await fn(this.helper);
                } catch (retryError) {
                    throw normalizeLearnError(retryError);
                }
            }
            throw err;
        }
    }

    /** 当前学期（缓存 1 小时） */
    async getCurrentSemester(): Promise<SemesterInfo> {
        if (this.semesterCache && this.semesterCache.expireAt > Date.now()) {
            return this.semesterCache.value;
        }
        const semester = await this.call((h) => h.getCurrentSemester());
        this.semesterCache = {value: semester, expireAt: Date.now() + 3600 * 1000};
        return semester;
    }

    /** 课程列表。semesterId 省略时查当前学期；按学期缓存 10 分钟 */
    async getCourses(semesterId?: string): Promise<CourseInfo[]> {
        const id = semesterId ?? (await this.getCurrentSemester()).id;
        const cached = this.courseCache.get(id);
        if (cached && cached.expireAt > Date.now()) return cached.value;
        const courses = await this.call((h) => h.getCourseList(id));
        this.courseCache.set(id, {value: courses, expireAt: Date.now() + COURSE_CACHE_TTL_MS});
        return courses;
    }

    /** 某门课的全部通知（含正文/已读/附件） */
    async getNotifications(courseId: string): Promise<Notification[]> {
        return this.call((h) => h.getNotificationList(courseId));
    }

    /** 某门课的全部作业（含截止时间/提交状态/成绩/评语） */
    async getHomeworkList(courseId: string): Promise<Homework[]> {
        return this.call((h) => h.getHomeworkList(courseId));
    }

    /** 某门课的课件文件列表 */
    async getFileList(courseId: string): Promise<LearnFile[]> {
        return this.call((h) => h.getFileList(courseId));
    }

    /** 学堂日历。start/end 形如 yyyymmdd，窗口不能超过 29 天（上游限制） */
    async getCalendar(startDate: string, endDate: string): Promise<CalendarEvent[]> {
        return this.call((h) => h.getCalendar(startDate, endDate));
    }

    /**
     * 提交作业。id 是学生作业 ID（Homework.id）；attachment 为本地文件内容。
     * 上游要求文件字段只能有一个：传了附件就是「附件 + 文字说明」，不传就是纯文字。
     */
    async submitHomework(
        id: string,
        content: string,
        attachment?: {filename: string; content: Blob},
    ): Promise<void> {
        return this.call((h) => h.submitHomework(id, content, attachment));
    }

    /** 带登录态下载文件（独立下载会话，懒登录、失效自动重登一次） */
    async downloadFile(url: string) {
        try {
            return await this.downloads.download(url);
        } catch (e) {
            throw normalizeLearnError(e);
        }
    }

    /** 便于排障：暴露 CSRF token 状态 */
    get loggedIn(): boolean {
        return this.helper.getCSRFToken() !== "";
    }
}

export type {LearnCredentials} from "./downloadSession";
export {ThuError};
