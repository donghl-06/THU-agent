import {useEffect, useState, type ReactNode} from "react";
import {AnimatePresence, motion} from "motion/react";
import {ArrowUpRight, Bell, BookOpen, CalendarDays, Check, ChevronDown, CreditCard, ExternalLink, GraduationCap, LayoutDashboard, Library, LoaderCircle, LockKeyhole, Mail, Megaphone, Newspaper, RefreshCw, Search, Sparkles, Volleyball, Wifi, Zap, type LucideIcon} from "lucide-react";
import type {DashboardGroup, DashboardItem, DashboardNewsDetail, DashboardPanel} from "../../shared/dashboard";
import {dashboardLink} from "../../shared/dashboard";
import type {Assistant} from "../lib/useAssistant";
import {useDashboard} from "../lib/useDashboard";
import {request} from "../lib/api";
import {contentReveal, staggeredReveal} from "../lib/motion";
import {EmptyState, IconButton} from "./Controls";
import {Modal} from "./Modal";
import "./dashboard.css";

const icons: Record<string, LucideIcon> = {card: CreditCard, electricity: Zap, network: Wifi, homework: BookOpen, notices: Megaphone, schedule: CalendarDays, news: Newspaper, bookings: CalendarDays, seats: Library, sports: Volleyball, courses: GraduationCap, files: BookOpen, calendar: CalendarDays, emails: Mail, report: GraduationCap, rooms: Library, dorm: Sparkles};
const groups: {id: DashboardGroup | "all"; label: string}[] = [{id: "all", label: "全部状态"}, {id: "learning", label: "学习与教学"}, {id: "campus", label: "校园资讯与资源"}, {id: "life", label: "生活服务"}];
const panelOrder = ["homework", "notices", "schedule", "news", "card", "electricity", "network", "bookings", "seats", "sports", "courses", "files", "calendar", "emails", "report", "rooms", "dorm"];
const formatTime = (value?: number) => value ? new Date(value).toLocaleTimeString("zh-CN", {timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false}) : "尚未更新";
const rowTime = (value?: string) => value && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false}) : value;

export function DashboardPage({app, sidebarToggle}: {app: Assistant; sidebarToggle?: ReactNode}) {
    return <section className="dashboard-page" aria-label="校园状态看板">
        {!app.authenticated ? <>
            <header className="dashboard-heading"><div className="tasks-title-row">{sidebarToggle}<h1>状态看板</h1></div></header>
            <div className="tasks-empty"><EmptyState icon={LockKeyhole}>连接清华账号后，查看课程、作业、校园资讯和生活服务状态。</EmptyState><button className="button primary" onClick={app.openLogin}>连接账号</button></div>
        </> : <DashboardWorkspace key={app.profile?.username ?? "account"} sidebarToggle={sidebarToggle}/>}
    </section>;
}

function DashboardWorkspace({sidebarToggle}: {sidebarToggle?: ReactNode}) {
    const {snapshot, error, automatic, setAutomatic, fetching, refresh} = useDashboard();
    const [group, setGroup] = useState<DashboardGroup | "all">("all");
    const [query, setQuery] = useState("");
    const [detail, setDetail] = useState<DashboardItem>();
    // 板块详情弹框只记 id：刷新后 snapshot 换新对象，弹框内容跟着最新数据走
    const [panelDetailId, setPanelDetailId] = useState<string>();
    const panels = snapshot?.panels ?? [];
    const updating = panels.some(panel => panel.refreshing);
    const ready = panels.filter(panel => panel.updatedAt).length;
    const failed = panels.filter(panel => ["error", "unavailable"].includes(panel.status)).length;
    const needle = query.trim().toLocaleLowerCase();
    const shown = panels.filter(panel => (group === "all" || panel.group === group) && (!needle || [panel.title, panel.description, ...(panel.data?.items ?? []).flatMap(item => [item.title, item.subtitle ?? ""])].join(" ").toLocaleLowerCase().includes(needle)))
        .sort((a, b) => panelOrder.indexOf(a.id) - panelOrder.indexOf(b.id));
    const detailPanel = panelDetailId ? panels.find(panel => panel.id === panelDetailId) : undefined;

    return <motion.div initial="hidden" animate="visible" variants={staggeredReveal}>
        <motion.header className="dashboard-heading" variants={contentReveal}>
            <div><div className="dashboard-eyebrow"><LayoutDashboard size={14}/><span>校园概览</span></div><div className="tasks-title-row">{sidebarToggle}<h1>状态看板</h1></div><p>课程、待办与校园生活，一处查看。</p></div>
            <div className="dashboard-actions"><label className="dashboard-auto"><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)}/><span>自动刷新</span></label><button className="button secondary" onClick={() => refresh()} disabled={fetching || updating}><RefreshCw size={15} className={updating ? "dashboard-spin" : ""}/>{updating ? "更新中" : "刷新全部"}</button></div>
        </motion.header>
        <motion.div className="dashboard-overview" variants={contentReveal}>
            {[{id: "card", label: "校园卡余额", icon: CreditCard}, {id: "electricity", label: "剩余电量", icon: Zap}, {id: "homework", label: "待交作业", icon: BookOpen}, {id: "schedule", label: "今日课程", icon: CalendarDays}].map(({id, label, icon: Icon}) => {
                const panel = panels.find(panel => panel.id === id);
                const metric = panel?.data?.metrics?.find(metric => metric.label === label);
                const empty = panel?.status === "empty" && ["homework", "schedule"].includes(id);
                return <button key={id} className="dashboard-stat" aria-label={`查看${label}详情`} onClick={() => { setGroup("all"); setQuery(""); requestAnimationFrame(() => document.getElementById(`dashboard-${id}`)?.scrollIntoView({behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start"})); }}>
                    <span className="dashboard-stat-label"><Icon size={15}/>{label}<ArrowUpRight size={13}/></span><strong>{metric?.value ?? (empty ? "0" : "—")}<small>{metric?.unit ?? (empty ? "项" : "")}</small></strong>
                    <span className={panel?.status === "error" ? "dashboard-warning" : ""}>{panel?.status === "error" ? panel.updatedAt ? `上次成功 ${formatTime(panel.updatedAt)}` : "暂时不可用" : panel?.refreshing ? "正在更新" : panel?.updatedAt ? `${formatTime(panel.updatedAt)} 更新` : "等待查询"}</span>
                </button>;
            })}
        </motion.div>
        <div className="dashboard-status" role="status"><span className={`dashboard-dot ${updating ? "is-updating" : ""}`}/>{snapshot ? `已获取 ${ready} / ${panels.length} 项` : "正在连接校园服务"}{failed > 0 && <span className="dashboard-warning">{failed} 项暂不可用</span>}<span className="dashboard-status-note">{snapshot?.paused ? "当前任务进行中，查询稍后继续" : automatic ? "各项每 2–60 分钟更新 · 隐藏页面时暂停" : "自动刷新已暂停"}</span></div>
        {error && <div className="dashboard-error" role="alert"><span>{error}</span><button onClick={() => refresh()}>重试</button></div>}
        <div className="dashboard-controls"><div className="dashboard-tabs" role="tablist" aria-label="看板分类">{groups.map(item => <button key={item.id} role="tab" aria-selected={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>)}</div><label className="dashboard-search"><Search size={15}/><input aria-label="搜索看板" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索课程、资讯…"/></label></div>
        {!snapshot ? <div className="dashboard-loading"><LoaderCircle size={22} className="dashboard-spin"/><p>正在加载看板，各项数据将陆续显示</p></div> : !shown.length ? <EmptyState icon={Search}>没有找到相关内容</EmptyState> : <div className="dashboard-grid">{shown.map(panel => <StatusPanel key={panel.id} panel={panel} refresh={() => refresh(panel.id)} busy={fetching} expand={() => setPanelDetailId(panel.id)}/>)}</div>}
        <footer className="dashboard-footer"><Check size={13}/>仅查询信息，操作请前往对话 · 时间均为北京时间<span>数据来自各校园服务，查询失败不代表余额为零或没有待办。</span></footer>
        <AnimatePresence>{detailPanel && <PanelDialog panel={detailPanel} close={() => setPanelDetailId(undefined)} open={setDetail} refresh={() => refresh(detailPanel.id)} busy={fetching}/>}</AnimatePresence>
        <AnimatePresence>{detail && <DetailDialog item={detail} close={() => setDetail(undefined)}/>}</AnimatePresence>
    </motion.div>;
}

function StatusPanel({panel, refresh, busy, expand}: {panel: DashboardPanel; refresh: () => void; busy: boolean; expand: () => void}) {
    const Icon = icons[panel.id] ?? Bell;
    const items = panel.data?.items ?? [];
    const error = panel.status === "error" || panel.status === "unavailable";
    // 主看板是总览：卡片只放总结性内容（指标 + 一行摘要），明细全部收进「查看详情」弹框
    const summary = items.length > 0 ? `共 ${items.length} 条 · ${items[0].title}`
        : panel.data?.images?.length ? `${panel.data.images.length} 张图片`
        : panel.data ? (panel.data.metrics?.length ? "" : "暂无记录") : "";
    return <article className="dashboard-panel" id={`dashboard-${panel.id}`} aria-labelledby={`dashboard-title-${panel.id}`}>
        <header><div className="dashboard-panel-title"><Icon size={18}/><h2 id={`dashboard-title-${panel.id}`}>{panel.title}</h2>{items.length > 0 && <span>{items.length}</span>}</div><IconButton icon={RefreshCw} label={`刷新${panel.title}`} onClick={refresh} disabled={busy || panel.refreshing || panel.status === "unavailable"} className={panel.refreshing ? "dashboard-spin-icon" : ""}/></header>
        <p className="dashboard-description">{panel.description}</p>
        <div className="dashboard-panel-body">
            {error && <div className="dashboard-panel-error"><span>{panel.error}{panel.updatedAt ? " 上次成功结果见详情。" : ""}</span>{panel.status !== "unavailable" && <button onClick={refresh} disabled={busy || panel.refreshing}>重试</button>}</div>}
            {panel.data?.metrics && <div className="dashboard-metrics">{panel.data.metrics.map(metric => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}<small>{metric.unit}</small></strong></div>)}</div>}
            {!panel.data && !error
                ? <div className="dashboard-pending"><LoaderCircle size={16} className="dashboard-spin"/>{panel.refreshing ? "正在查询…" : "等待查询"}</div>
                : summary && <p className="dashboard-summary">{summary}</p>}
        </div>
        <footer><span>{panel.updatedAt ? `${formatTime(panel.updatedAt)} 更新` : "尚无成功记录"} · 每 {panel.intervalMs / 60_000} 分钟</span><button onClick={expand}>查看详情<ArrowUpRight size={13}/></button></footer>
    </article>;
}

/** 板块详情内容（仅弹框放大态使用）：错误提示、指标、全部条目、图片与备注 */
function PanelBody({panel, refresh, busy, open}: {panel: DashboardPanel; refresh: () => void; busy: boolean; open: (item: DashboardItem) => void}) {
    const items = panel.data?.items ?? [];
    const error = panel.status === "error" || panel.status === "unavailable";
    return <>
        {error && <div className="dashboard-panel-error"><span>{panel.error}{panel.updatedAt ? " 下方为上次成功获取的结果。" : ""}</span>{panel.status !== "unavailable" && <button onClick={refresh} disabled={busy || panel.refreshing}>重试</button>}</div>}
        {panel.data?.metrics && <div className="dashboard-metrics">{panel.data.metrics.map(metric => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}<small>{metric.unit}</small></strong></div>)}</div>}
        {!panel.data && !error ? <div className="dashboard-pending"><LoaderCircle size={16} className="dashboard-spin"/>{panel.refreshing ? "正在查询…" : "等待查询"}</div> : <>
            {items.length > 0 ? <ul className="dashboard-list">{items.map((item, index) => <li key={`${item.title}-${index}`}>
                {item.body || item.newsRef ? <button className="dashboard-item" onClick={() => open(item)}><ItemContent item={item}/><ChevronDown size={14}/></button> : <div className="dashboard-item"><ItemContent item={item}/></div>}
                {dashboardLink(item.href) && <a className="dashboard-file-link" href={dashboardLink(item.href)} target="_blank" rel="noopener noreferrer">打开文件<ExternalLink size={12}/></a>}
            </li>)}</ul> : panel.data && !panel.data.images?.length && <p className="dashboard-empty">{panel.status === "empty" || !panel.data.metrics?.length ? "暂无记录" : "暂无更多明细"}</p>}
            {panel.data?.images?.map((src, i) => <a className="dashboard-image" key={i} href={src} target="_blank" rel="noopener noreferrer"><img src={src} alt={`宿舍卫生公示 ${i + 1}`} loading="lazy"/></a>)}
            {panel.data?.note && <p className="dashboard-note">{panel.data.note}</p>}
        </>}
    </>;
}

/** 板块详情弹框（放大态）：展示该板块全部内容，点「收起」或关闭按钮回到主看板 */
function PanelDialog({panel, close, open, refresh, busy}: {panel: DashboardPanel; close: () => void; open: (item: DashboardItem) => void; refresh: () => void; busy: boolean}) {
    return <Modal title={panel.title} close={close} className="dashboard-panel-detail">
        <p className="dashboard-detail-meta">{panel.description}</p>
        <PanelBody panel={panel} refresh={refresh} busy={busy} open={open}/>
        <div className="dashboard-panel-detail-footer">
            <span>{panel.updatedAt ? `${formatTime(panel.updatedAt)} 更新` : "尚无成功记录"} · 每 {panel.intervalMs / 60_000} 分钟自动刷新</span>
            <button className="button secondary" onClick={close}>收起</button>
        </div>
    </Modal>;
}

function ItemContent({item}: {item: DashboardItem}) {
    return <div className="dashboard-item-content"><div><strong>{item.title}</strong>{item.badge && <span className={`dashboard-badge ${item.attention ? "attention" : ""}`}>{item.badge}</span>}</div>{item.subtitle && <span>{item.subtitle}</span>}{item.time && <time>{rowTime(item.time)}</time>}</div>;
}

function DetailDialog({item, close}: {item: DashboardItem; close: () => void}) {
    const [detail, setDetail] = useState<DashboardNewsDetail>();
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!item.newsRef) return;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 50_000);
        let stopped = false;
        setError("");
        void request(`/api/dashboard/news?ref=${encodeURIComponent(item.newsRef)}`, undefined, controller.signal)
            .then(response => response.json() as Promise<DashboardNewsDetail>).then(data => { if (!stopped) setDetail(data); })
            .catch(() => { if (!stopped) setError("正文暂时无法加载，请稍后重试。"); })
            .finally(() => clearTimeout(timeout));
        return () => { stopped = true; clearTimeout(timeout); controller.abort(); };
    }, [item.newsRef, attempt]);
    return <Modal title={item.title} close={close} className="dashboard-detail"><p className="dashboard-detail-meta">{item.subtitle} {rowTime(item.time)}</p>{error ? <div className="dashboard-error" role="alert">{error}<button onClick={() => setAttempt(attempt + 1)}>重试</button></div> : item.newsRef && !detail ? <div className="dashboard-loading"><LoaderCircle size={22} className="dashboard-spin"/>正在读取正文</div> : <><div className="dashboard-detail-body">{detail?.content || item.body || "此条资讯未提供正文。"}</div>{detail?.note && <p className="dashboard-note">{detail.note}</p>}</>}</Modal>;
}
