import type {Skill, SkillResult} from "../skills/base/types";
import type {DashboardNewsDetail, DashboardPanel, DashboardSnapshot} from "../shared/dashboard";
import type {CampusNewsDetailData} from "../skills/news/getCampusNewsDetail";
import {boundDashboardContent, dashboardSources, type DashboardSource} from "./dashboardSources";
import {beijingDateString} from "../skills/learn/format";

const errorMessages: Record<string, string> = {
    AUTH_FAILED: "此服务需要有效的登录凭证，请重新连接清华账号。",
    AUTH_REQUIRED: "此服务需要重新认证，请在账号菜单重新连接清华账号。",
    AUTH_EXPIRED: "登录状态已过期，请重新连接清华账号。",
    NETWORK_AUTH_REQUIRED: "校园网查询需要可用的校内网络、账号凭证和验证码识别配置。",
    DORM_SCORE_UNAVAILABLE: "宿舍卫生公示暂不可用，请稍后重试。",
    TIMEOUT: "查询超时，可稍后刷新；已有结果仍保留。",
    NETWORK_ERROR: "暂时无法连接校园服务，请检查校园网或稍后重试。",
};

function safeError(code?: string): string {
    return errorMessages[code ?? ""] ?? "校园服务暂未返回可用结果，请稍后重试。";
}

/** In-memory, account-scoped, read-only aggregation. No LLM, writes or background interval. */
export class DashboardService {
    private readonly skills: Map<string, Skill>;
    private readonly panels = new Map<string, DashboardPanel>();
    private readonly pending = new Set<string>();
    private readonly inflight = new Map<string, Promise<void>>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly dates = new Map<string, string>();
    private disposed = false;
    private active = 0;

    constructor(skills: Skill[], private readonly options: {
        timeoutMs?: number;
        now?: () => number;
        canRun?: () => boolean;
    } = {}) {
        this.skills = new Map(skills.map(skill => [skill.name, skill]));
        for (const source of dashboardSources) {
            const skill = this.skills.get(source.skill);
            const available = skill && !skill.requiresConfirmation;
            this.panels.set(source.id, {
                id: source.id, title: source.title, group: source.group, description: source.description,
                intervalMs: source.intervalMs, status: available ? "idle" : "unavailable", refreshing: false,
                ...(!available ? {error: "当前服务未提供这项只读查询。"} : {}),
            });
        }
    }

    private now() { return this.options.now?.() ?? Date.now(); }

    snapshot(refresh = false, force?: string): DashboardSnapshot {
        const now = this.now();
        const paused = this.disposed || this.options.canRun?.() === false;
        if (refresh && !paused) {
            const date = beijingDateString(0, new Date(now));
            for (const source of dashboardSources) {
                const panel = this.panels.get(source.id)!;
                if (panel.status === "unavailable" || panel.refreshing || this.inflight.has(source.id)) continue;
                const forced = (force === "all" || force === source.id) && (!panel.attemptedAt || now - panel.attemptedAt >= 15_000);
                const dateChanged = this.dates.has(source.id) && this.dates.get(source.id) !== date;
                if (forced || dateChanged || !panel.nextRefreshAt || now >= panel.nextRefreshAt) {
                    panel.refreshing = true;
                    this.pending.add(source.id);
                }
            }
        }
        // Passive polling must also resume a batch paused by a foreground chat/login.
        if (!paused) this.pump();
        return {panels: [...this.panels.values()].map(panel => ({...panel})), generatedAt: now, paused};
    }

    private pump() {
        if (this.disposed || this.options.canRun?.() === false) return;
        for (const id of this.pending) {
            if (this.active >= 4) break;
            const source = dashboardSources.find(source => source.id === id)!;
            // Learn queries fan out over courses. Serialize their initial login and request batches.
            if (source.skill.startsWith("get_learn_") && [...this.inflight.keys()].some(key => dashboardSources.find(s => s.id === key)?.skill.startsWith("get_learn_"))) continue;
            this.pending.delete(id);
            this.active++;
            const work = this.run(source).finally(() => {
                this.inflight.delete(id);
                this.active--;
                this.pump();
            });
            this.inflight.set(id, work);
        }
    }

    private async run(source: DashboardSource) {
        const panel = this.panels.get(source.id)!;
        panel.attemptedAt = this.now();
        this.dates.set(source.id, beijingDateString(0, new Date(this.now())));
        // The underlying Skill API has no cancellation. Retain its in-flight slot after timeout
        // until it actually settles, preventing repeated refreshes from piling up requests.
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            if (!this.disposed) this.failed(panel, "TIMEOUT");
        }, this.options.timeoutMs ?? 45_000);
        this.timers.add(timer);
        try {
            const result = await this.skills.get(source.skill)!.execute(source.input());
            if (this.disposed || timedOut) return;
            if (result.success) {
                const data = boundDashboardContent(source.normalize(result.data));
                Object.assign(panel, {data, status: data.items?.length || data.images?.length || data.metrics?.length ? "ready" : "empty", updatedAt: this.now(), error: undefined, refreshing: false, nextRefreshAt: this.now() + source.intervalMs});
            } else if (source.emptyOnNotFound && result.error?.code === "NOT_FOUND") {
                Object.assign(panel, {data: {items: [], note: "当前没有可显示的记录。"}, status: "empty", updatedAt: this.now(), error: undefined, refreshing: false, nextRefreshAt: this.now() + source.intervalMs});
            } else this.failed(panel, result.error?.code);
        } catch {
            // Never serialize thrown errors: upstream exceptions may carry cookies or response bodies.
            if (!this.disposed && !timedOut) this.failed(panel);
        } finally {
            clearTimeout(timer);
            this.timers.delete(timer);
        }
    }

    private failed(panel: DashboardPanel, code?: string) {
        const error = panel.id === "emails" && code === "AUTH_FAILED" ? "邮箱需要单独配置邮箱账号和客户端授权码，请检查邮箱配置。" : safeError(code);
        Object.assign(panel, {status: "error", error, refreshing: false, nextRefreshAt: this.now() + Math.max(panel.intervalMs, 60_000)});
    }

    async newsDetail(ref: string): Promise<DashboardNewsDetail | undefined> {
        const skill = this.skills.get("get_campus_news_detail");
        if (this.disposed || !skill || skill.requiresConfirmation || !this.panels.get("news")?.data?.items?.some(item => item.newsRef === ref)) return undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                skill.execute({url: ref}) as Promise<SkillResult<CampusNewsDetailData>>,
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), this.options.timeoutMs ?? 45_000); }),
            ]);
            if (this.disposed || !result.success || !result.data) return undefined;
            return {title: result.data.title, content: result.data.content.slice(0, 8000), note: result.data.note};
        } catch { return undefined; }
        finally { clearTimeout(timer); }
    }

    dispose() {
        this.disposed = true;
        this.pending.clear();
        this.panels.clear();
        this.skills.clear();
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }
}
