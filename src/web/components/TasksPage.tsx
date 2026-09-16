import {useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode} from "react";
import {AnimatePresence, motion} from "motion/react";
import {ArrowLeft, ArrowUpRight, CalendarClock, Clock3, History, LoaderCircle, LockKeyhole, Pause, Pencil, Play, Plus, RefreshCw, RotateCcw, Search, Square, Trash2} from "lucide-react";
import type {ScheduledRun, ScheduledSnapshot, ScheduledTask, ScheduledTaskInput, TaskRunStatus, TaskSchedule} from "../../tasks/scheduledTypes";
import type {AgentTask} from "../../tasks/types";
import type {Assistant} from "../lib/useAssistant";
import {EmptyState, IconButton} from "./Controls";
import {Modal} from "./Modal";
import {contentReveal, staggeredReveal} from "../lib/motion";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const runLabels: Record<TaskRunStatus, string> = {running: "执行中", completed: "已完成", failed: "执行失败", needs_attention: "待处理", cancelled: "已停止", interrupted: "已中断", missed: "已错过"};
const formatDate = (at?: number) => at ? new Date(at).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false}) : "—";
const scheduleLabel = (schedule: TaskSchedule) => schedule.frequency === "once" ? `${schedule.date} ${schedule.time}`
    : `${schedule.frequency === "daily" ? "每天" : `每周${schedule.weekdays?.map(day => weekdays[day - 1]).join("、")}`} ${schedule.time}`;

async function taskRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, body === undefined ? {cache: "no-store", signal} : {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal,
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({})) as {error?: string};
        throw new Error(data.error ?? (response.status === 401 ? "登录已过期，请重新连接清华账号。" : "操作未完成，请检查连接后重试。"));
    }
    return response.json() as Promise<T>;
}

export function TasksPage({app, sidebarToggle}: {app: Assistant; sidebarToggle?: ReactNode}) {
    const [data, setData] = useState<ScheduledSnapshot>({tasks: [], runs: [], busy: false});
    const [legacy, setLegacy] = useState<AgentTask[]>([]);
    const [tab, setTab] = useState<"tasks" | "history">("tasks");
    const [filter, setFilter] = useState("");
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [pending, setPending] = useState(false);
    const [editing, setEditing] = useState<ScheduledTask | "new" | null>(null);
    const [confirmation, setConfirmation] = useState<{path: string; id: string; title: string; description: string} | null>(null);
    const sequence = useRef(0);
    const mutation = useRef(false);

    const refresh = useCallback(async (signal?: AbortSignal) => {
        const version = ++sequence.current;
        try {
            const [next, old] = await Promise.all([
                taskRequest<ScheduledSnapshot>("/api/scheduled-tasks", undefined, signal),
                taskRequest<{tasks: AgentTask[]}>("/api/tasks", undefined, signal),
            ]);
            if (version === sequence.current && !signal?.aborted) { setData(next); setLegacy(old.tasks); setError(""); }
        } catch (error) {
            if (version === sequence.current && !signal?.aborted) setError(error instanceof Error ? error.message : "暂时无法加载任务。");
        } finally { if (version === sequence.current && !signal?.aborted) setLoading(false); }
    }, []);
    useEffect(() => {
        if (!app.authenticated) { setLoading(false); return; }
        const controller = new AbortController();
        void refresh(controller.signal);
        const timer = setInterval(() => { if (!mutation.current) void refresh(controller.signal); }, 2000);
        return () => { controller.abort(); clearInterval(timer); sequence.current++; };
    }, [app.authenticated, refresh]);

    async function act(path: string, body: unknown) {
        if (mutation.current) return;
        mutation.current = true;
        sequence.current++;
        setPending(true);
        try {
            await taskRequest(path, body);
            await refresh();
            if (path === "/api/scheduled-tasks/run") {
                setTab("history"); setFilter((body as {id: string}).id); setQuery("");
            }
            setConfirmation(null);
        } catch (error) { app.notify(error instanceof Error ? error.message : "操作失败，请重试。", "error"); }
        finally { mutation.current = false; setPending(false); }
    }
    const running = new Set(data.runs.filter(run => run.status === "running").map(run => run.taskId));
    const tasks = data.tasks.filter(task => `${task.title} ${task.prompt}`.toLowerCase().includes(query.toLowerCase()));
    const runs = data.runs.filter(run => (!filter || run.taskId === filter) && `${run.title} ${run.prompt} ${run.summary ?? ""}`.toLowerCase().includes(query.toLowerCase()));
    const legacyTasks = legacy.filter(task => (tab === "tasks" ? !task.done && !task.cancelled : task.done || task.cancelled) && task.title.toLowerCase().includes(query.toLowerCase()));
    const taskNames = [...new Map([...data.tasks, ...data.runs].map(task => ["taskId" in task ? task.taskId : task.id, task.title])).entries()];
    const hasRows = tab === "tasks" ? tasks.length || legacyTasks.length : runs.length || (!filter && legacyTasks.length);

    return <motion.section className="tasks-page" aria-label="定时任务管理" initial="hidden" animate="visible" variants={staggeredReveal}>
        <motion.div className="tasks-heading" variants={contentReveal}><div><div className="tasks-eyebrow"><CalendarClock size={16}/>自动安排 · 随时接着聊</div><div className="tasks-title-row">{sidebarToggle}<h1>定时任务</h1></div><p>按计划交给清灵处理，在这里查看结果和继续对话。</p></div>
            <button className="button primary" onClick={() => app.authenticated ? setEditing("new") : app.openLogin()} disabled={pending}><Plus size={17}/>新建任务</button></motion.div>
        {!app.authenticated ? <motion.div className="tasks-empty" variants={contentReveal}><EmptyState icon={LockKeyhole}>连接清华账号后，创建和管理你的定时任务。</EmptyState><button className="button secondary" onClick={app.openLogin}>连接账号</button></motion.div> : <>
            <motion.div className="tasks-controls" variants={contentReveal}>
                <div className="tasks-tabs" role="tablist" aria-label="任务视图">
                    <button role="tab" aria-selected={tab === "tasks"} onClick={() => { setTab("tasks"); setFilter(""); }}><Clock3 size={16}/>任务计划<span>{data.tasks.length + legacy.filter(task => !task.done && !task.cancelled).length}</span></button>
                    <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}><History size={16}/>执行历史<span>{data.runs.length + legacy.filter(task => task.done || task.cancelled).length}</span></button>
                </div>
                <div className="tasks-tools"><label className="tasks-search"><Search size={16}/><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)}/></label><IconButton icon={RefreshCw} label="刷新任务" disabled={pending} onClick={() => void refresh()}/></div>
            </motion.div>
            <motion.div className="tasks-body" variants={contentReveal}>
            {tab === "history" && <div className="tasks-filter"><label>所属任务<select aria-label="筛选所属任务" value={filter} onChange={event => setFilter(event.target.value)}><option value="">全部任务</option>{taskNames.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label><span>每次执行都有独立会话</span></div>}
            {error && <p className="tasks-error" role="alert">{error}<button onClick={() => void refresh()}>重试</button></p>}
            {loading ? <EmptyState icon={LoaderCircle}>正在加载任务…</EmptyState> : !hasRows ? <div className="tasks-empty"><EmptyState icon={tab === "tasks" ? CalendarClock : History}>{query || filter ? "没有匹配的记录" : tab === "tasks" ? "还没有任务，设置一个时间，让清灵按时处理。" : "还没有执行记录。任务运行后，结果会保存在这里。"}</EmptyState>
                {tab === "tasks" && !query && <button className="button secondary" onClick={() => setEditing("new")}><Plus size={16}/>创建第一个任务</button>}</div> : <div className="tasks-list" role="tabpanel" aria-label={tab === "tasks" ? "任务计划" : "执行历史"}>
                {tab === "tasks" ? tasks.map(task => <article className="task-row" key={task.id}>
                    <div className={`task-row-icon ${running.has(task.id) ? "is-running" : ""}`}><Clock3 size={21}/></div>
                    <div className="task-row-content"><div className="task-title-line"><button className="task-title" onClick={() => { setFilter(task.id); setTab("history"); }}>{task.title}</button><span className={`task-status ${running.has(task.id) ? "running" : task.enabled ? "enabled" : ""}`}>{running.has(task.id) ? "执行中" : task.enabled ? "已启用" : task.nextRunAt ? "已暂停" : "已结束"}</span></div>
                        <p className="task-prompt">{task.prompt}</p><div className="task-meta"><span>{scheduleLabel(task.schedule)}</span><span>{task.enabled ? `下次 ${formatDate(task.nextRunAt)}` : task.nextRunAt ? "暂停自动执行" : "可编辑时间或再次手动运行"}</span></div></div>
                    <div className="task-actions"><IconButton icon={Play} label={`立即运行：${task.title}`} disabled={pending || data.busy || running.size > 0} onClick={() => void act("/api/scheduled-tasks/run", {id: task.id})}/>
                        <IconButton icon={task.enabled ? Pause : Play} label={`${task.enabled ? "暂停" : "启用"}任务：${task.title}`} disabled={pending || (!task.enabled && !task.nextRunAt)} onClick={() => void act("/api/scheduled-tasks/toggle", {id: task.id, enabled: !task.enabled})}/>
                        <IconButton icon={Pencil} label={`编辑任务：${task.title}`} disabled={pending} onClick={() => setEditing(task)}/>
                        <IconButton icon={Trash2} label={`删除任务：${task.title}`} disabled={pending || running.has(task.id)} onClick={() => setConfirmation({path: "/api/scheduled-tasks/delete", id: task.id, title: "删除任务", description: `删除「${task.title}」后不再自动执行，已有执行历史和会话仍会保留。`})}/></div>
                </article>) : runs.map(run => <RunRow key={run.id} run={run} pending={pending} runDisabled={data.busy || running.size > 0} open={() => void app.openTaskSession(run.sessionId!)}
                    rerun={data.tasks.some(task => task.id === run.taskId) ? () => void act("/api/scheduled-tasks/run", {id: run.taskId}) : undefined}
                    stop={() => void act("/api/scheduled-tasks/stop", {id: run.id})}
                    remove={() => setConfirmation({path: "/api/scheduled-tasks/delete-run", id: run.id, title: "删除执行记录", description: "这条执行记录及其会话（包括后续对话）将一并删除，无法恢复。任务计划不受影响。"})}/>)}
                {!filter && legacyTasks.length > 0 && <div className="legacy-task-label">对话中创建的提醒与预约</div>}
                {!filter && legacyTasks.map(task => <article className="task-row" key={task.id}><div className="task-row-icon"><CalendarClock size={21}/></div><div className="task-row-content"><div className="task-title-line"><strong>{task.title}</strong><span className="task-status">{task.cancelled ? "已取消" : task.done ? "已结束" : "已启用"}</span></div><p className="task-prompt">{task.lastMessage ?? (task.kind === "booking" ? "按已确认的预约信息执行" : task.kind === "monitor" ? "按条件检查并提醒" : "到时提醒")}</p><div className="task-meta">{formatDate(task.nextRunAt)}</div></div><div className="task-actions"><IconButton icon={ArrowUpRight} label={`打开原会话：${task.title}`} onClick={() => void app.openTaskSession(task.sessionId)}/>{!task.done && !task.cancelled && <IconButton icon={Square} label={`取消任务：${task.title}`} disabled={pending} onClick={() => setConfirmation({path: "/api/tasks/cancel", id: task.id, title: "取消任务", description: `停止「${task.title}」的后续执行。`})}/>}</div></article>)}
            </div>}
            </motion.div>
            <motion.p className="tasks-footnote" variants={contentReveal}><Clock3 size={14}/>北京时间（UTC+8）· 自动执行需要本地服务运行并保持登录。错过超过 10 分钟的执行会跳过。</motion.p>
        </>}
        <AnimatePresence>{editing && <TaskEditor task={editing === "new" ? undefined : editing} close={() => setEditing(null)} save={async input => {
            await taskRequest(`/api/scheduled-tasks/${editing === "new" ? "create" : "update"}`, {...input, ...(editing !== "new" ? {id: editing.id} : {})});
            setEditing(null); await refresh(); app.notify("任务已保存", "success");
        }}/>}</AnimatePresence>
        <AnimatePresence>{confirmation && <Modal title={confirmation.title} close={pending ? undefined : () => setConfirmation(null)}><p className="dialog-description">{confirmation.description}</p><div className="modal-actions"><button className="button secondary" disabled={pending} onClick={() => setConfirmation(null)}>返回</button><button className="button primary" disabled={pending} onClick={() => void act(confirmation.path, {id: confirmation.id})}>{pending ? "处理中…" : "确认"}</button></div></Modal>}</AnimatePresence>
    </motion.section>;
}

function RunRow({run, pending, runDisabled, open, stop, remove, rerun}: {run: ScheduledRun; pending: boolean; runDisabled: boolean; open: () => void; stop: () => void; remove: () => void; rerun?: () => void}) {
    const preview = (run.summary || run.prompt).split(/\n\s*\n/)[0].replace(/\*\*|__|^#{1,6}\s+/g, "");
    return <article className="task-row run-row"><div className={`task-row-icon ${run.status === "running" ? "is-running" : ""}`}><History size={21}/></div><div className="task-row-content"><div className="task-title-line"><strong>{run.title}</strong><span className={`task-status ${run.status}`}>{runLabels[run.status]}</span></div><p className="task-prompt">{preview}</p><div className="task-meta"><span>{formatDate(run.startedAt)}</span><span>{run.trigger === "manual" ? "手动执行" : "定时执行"}</span>{run.finishedAt && <span>用时 {Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000))} 秒</span>}</div></div><div className="task-actions">
        {run.sessionId && <button className="task-open" onClick={open}>{run.status === "running" ? "查看进度" : "打开会话"}<ArrowUpRight size={15}/></button>}
        {run.status !== "running" && rerun && <IconButton icon={RotateCcw} label={`按当前计划再次运行：${run.title}`} disabled={pending || runDisabled} onClick={rerun}/>}
        {run.status === "running" ? <IconButton icon={Square} label={`停止执行：${run.title}`} disabled={pending} onClick={stop}/> : <IconButton icon={Trash2} label={`删除执行记录：${run.title}`} disabled={pending} onClick={remove}/>}</div></article>;
}

function TaskEditor({task, close, save}: {task?: ScheduledTask; close: () => void; save: (input: ScheduledTaskInput) => Promise<void>}) {
    const nextHour = new Date(Date.now() + 3_600_000 + 8 * 3_600_000).toISOString();
    const [title, setTitle] = useState(task?.title ?? "");
    const [prompt, setPrompt] = useState(task?.prompt ?? "");
    const [frequency, setFrequency] = useState<TaskSchedule["frequency"]>(task?.schedule.frequency ?? "daily");
    const [time, setTime] = useState(task?.schedule.time ?? "08:00");
    const [date, setDate] = useState(task?.schedule.date ?? nextHour.slice(0, 10));
    const [days, setDays] = useState(task?.schedule.weekdays ?? [1, 2, 3, 4, 5]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (saving) return;
        setSaving(true); setError("");
        try {
            if (frequency === "weekly" && !days.length) throw new Error("请至少选择一天。");
            await save({title, prompt, schedule: {frequency, time, ...(frequency === "once" ? {date} : {}), ...(frequency === "weekly" ? {weekdays: days} : {})}});
        } catch (error) { setError(error instanceof Error ? error.message : "任务保存失败。"); }
        finally { setSaving(false); }
    }
    return <Modal title={task ? "编辑任务" : "新建定时任务"} close={saving ? undefined : close} className="task-editor"><p className="dialog-description">设置清灵要做的事，以及执行时间。</p><form onSubmit={event => void submit(event)}><fieldset disabled={saving} className="task-fields">
        <label>任务名称<input required maxLength={80} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：每天早上整理课表"/></label>
        <label>任务内容<textarea required maxLength={8000} rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="查询今天的课程和待交作业，整理成一份简洁的今日安排。"/></label>
        <div className="task-schedule-fields"><label>执行频率<select value={frequency} onChange={event => { const value = event.target.value as TaskSchedule["frequency"]; setFrequency(value); if (value === "once" && !task) setTime(nextHour.slice(11, 16)); }}><option value="once">仅一次</option><option value="daily">每天</option><option value="weekly">每周</option></select></label><label>执行时间（北京时间）<input required type="time" value={time} onChange={event => setTime(event.target.value)}/></label></div>
        {frequency === "once" && <label>执行日期<input required type="date" value={date} onChange={event => setDate(event.target.value)} min={new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)}/></label>}
        {frequency === "weekly" && <div className="task-weekdays" role="group" aria-label="执行星期">{weekdays.map((label, index) => <button key={label} type="button" aria-label={`星期${label}`} aria-pressed={days.includes(index + 1)} onClick={() => setDays(current => current.includes(index + 1) ? current.filter(day => day !== index + 1) : [...current, index + 1])}>{label}</button>)}</div>}
        <p className="task-editor-note">每次执行创建独立会话。预约、付款等需要确认的操作，会留在执行历史中待你处理。{task && !task.enabled && "保存后仍保持暂停，请在列表中启用。"}</p>
        {error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={close}>取消</button><button type="submit" className="button primary">{saving ? "保存中…" : "保存任务"}</button></div>
    </fieldset></form></Modal>;
}

export function TaskConversationBanner({app}: {app: Assistant}) {
    const elsewhere = app.backgroundRunning && app.backgroundSession?.id !== app.session?.id;
    return <div className="task-conversation-banner"><button disabled={Boolean(app.turn)} onClick={elsewhere ? () => void app.openTaskSession(app.backgroundSession!.id) : app.openTasks}>{elsewhere ? <><Clock3 size={15}/>查看定时任务进度</> : <><ArrowLeft size={15}/>返回定时任务</>}</button><span>{elsewhere ? `「${app.backgroundSession?.title}」执行中` : app.backgroundRunning ? "正在执行 · 完成后可继续对话" : "任务会话 · 可以继续提问和处理结果"}</span></div>;
}
