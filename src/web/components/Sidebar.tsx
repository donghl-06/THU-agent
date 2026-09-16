import {useEffect, useRef, useState, type CSSProperties} from "react";
import {AnimatePresence, motion} from "motion/react";
import {Clock3, Command, LayoutDashboard, LockKeyhole, MessageCircle, PanelLeftClose, Search, SquarePen, Trash2, X} from "lucide-react";
import {AccountMenu} from "./AccountMenu";
import type {Assistant} from "../lib/useAssistant";
import {Brand, EmptyState, IconButton} from "./Controls";

function Selection() {
    return <motion.span aria-hidden="true" className="session-selection" layoutId="session-selection" transition={{type: "spring", stiffness: 440, damping: 38}}/>;
}

export function Sidebar({app, collapsed, mobileOpen, closeMobile, collapse, about}: {
    app: Assistant; collapsed: boolean; mobileOpen: boolean; closeMobile: () => void; collapse: () => void; about: () => void;
}) {
    const [query, setQuery] = useState("");
    const [searching, setSearching] = useState(false);
    const width = app.preferences.sidebarWidth;
    const sidebar = useRef<HTMLElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const [resizing, setResizing] = useState(false);
    const sessions = [...app.history.sessions].filter(s => !s.scheduledTaskId).sort((a, b) => b.createdAt - a.createdAt).filter(s => s.title.toLowerCase().includes(query.toLowerCase()));
    const tasksSelected = app.page === "tasks" || (app.page === "chat" && app.authenticated && Boolean(app.session?.scheduledTaskId));
    const newChatSelected = app.page === "chat" && !tasksSelected && (!app.authenticated || !app.session?.messages.length);
    const today = new Date().toLocaleDateString();
    useEffect(() => { if (searching) searchRef.current?.focus(); }, [searching]);
    useEffect(() => {
        if (!mobileOpen) return;
        const previous = document.activeElement as HTMLElement | null;
        sidebar.current?.querySelector<HTMLButtonElement>("button")?.focus();
        const keydown = (event: KeyboardEvent) => {
            if (document.querySelector("dialog[open]")) return;
            if (event.key === "Escape") closeMobile();
            if (event.key !== "Tab") return;
            const buttons = sidebar.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input, [tabindex='0']");
            const elements = Array.from(buttons ?? []).filter(el => el.offsetParent !== null);
            const first = elements[0], last = elements.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        };
        window.addEventListener("keydown", keydown);
        return () => { window.removeEventListener("keydown", keydown); previous?.focus(); };
    }, [mobileOpen, closeMobile]);

    function resize(next: number) {
        const value = Math.round(Math.max(220, Math.min(400, window.innerWidth * .4, next)));
        app.changePreferences({sidebarWidth: value});
    }

    return <>
        <AnimatePresence>{mobileOpen && <motion.button className="sidebar-scrim" aria-label="关闭会话列表" initial={{opacity: 0}} animate={{opacity: 1}} exit={{opacity: 0}} onClick={closeMobile}/>}</AnimatePresence>
        <aside ref={sidebar} className={`sidebar ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""} ${resizing ? "resizing" : ""}`} style={{"--sidebar-width": `${width}px`} as CSSProperties} aria-label="会话导航">
            <div className="sidebar-inner">
                <div className="sidebar-brand-row">
                    <button className="brand" onClick={about} aria-label="关于清灵"><Brand/><span>清灵<small>QingLing</small></span></button>
                    <IconButton icon={PanelLeftClose} label="收起侧栏" onClick={collapse} className="desktop-only"/>
                    <IconButton icon={X} label="关闭侧栏" onClick={closeMobile} className="mobile-only"/>
                </div>
                <button className={`new-chat ${newChatSelected ? "selected" : ""}`} aria-current={newChatSelected ? "page" : undefined} onClick={() => { app.newChat(); closeMobile(); }} disabled={Boolean(app.turn) || app.loginPending}>{newChatSelected && <Selection/>}<SquarePen size={19}/><span>新建对话</span><kbd><Command size={11}/>K</kbd></button>
                <button className={`new-chat tasks-nav ${tasksSelected ? "selected" : ""}`} aria-current={tasksSelected ? "page" : undefined} onClick={() => { app.openTasks(); closeMobile(); }} disabled={Boolean(app.turn) || app.loginPending}>{tasksSelected && <Selection/>}<Clock3 size={19}/><span>定时任务</span></button>
                <button className={`new-chat tasks-nav ${app.page === "dashboard" ? "selected" : ""}`} aria-current={app.page === "dashboard" ? "page" : undefined} onClick={() => { app.openDashboard(); closeMobile(); }} disabled={Boolean(app.turn) || app.loginPending}>{app.page === "dashboard" && <Selection/>}<LayoutDashboard size={19}/><span>状态看板</span></button>
                <div className="sidebar-section-label"><span>历史对话</span><IconButton icon={searching ? X : Search} label={searching ? "关闭搜索" : "搜索对话"} onClick={() => { setSearching(!searching); setQuery(""); }}/></div>
                <AnimatePresence>{searching && <motion.div className="session-search" initial={{height: 0, opacity: 0}} animate={{height: 42, opacity: 1}} exit={{height: 0, opacity: 0}}><Search size={15}/><input ref={searchRef} aria-label="搜索历史对话" placeholder="搜索对话" value={query} onChange={e => setQuery(e.target.value)}/></motion.div>}</AnimatePresence>
                <motion.nav layoutScroll className="session-list" aria-label="历史对话">
                    {!app.authenticated ? <EmptyState icon={LockKeyhole}>登录后查看历史对话</EmptyState> : !sessions.length ? <EmptyState icon={MessageCircle}>{query ? "没有找到相关对话" : "从一个问题开始"}</EmptyState> : sessions.map((session, index) => {
                        const isToday = new Date(session.createdAt).toLocaleDateString() === today;
                        const group = isToday ? "今天" : "更早";
                        const previousGroup = index && new Date(sessions[index - 1].createdAt).toLocaleDateString() === today ? "今天" : "更早";
                        return <div key={session.id}>
                            {(index === 0 || group !== previousGroup) && <div className="session-group">{group}</div>}
                            <div className={`session-item ${app.page === "chat" && session.id === app.history.activeId ? "active" : ""}`}>
                                {app.page === "chat" && session.id === app.history.activeId && <Selection/>}
                                <button className="session-link" aria-current={app.page === "chat" && session.id === app.history.activeId ? "page" : undefined} title={session.title} onClick={() => { app.switchSession(session.id); closeMobile(); }}><MessageCircle size={16}/><span>{session.title}</span></button>
                                <IconButton className="session-delete" icon={Trash2} label={`删除对话：${session.title}`} disabled={Boolean(app.turn) || app.confirmBusy} onClick={() => app.requestConfirmation({kind: "delete", session})}/>
                            </div>
                        </div>;
                    })}
                </motion.nav>
                <div className="sidebar-bottom">
                    <AccountMenu app={app} about={about}/>
                </div>
            </div>
            <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="调节侧栏宽度" aria-valuemin={220} aria-valuemax={400} aria-valuenow={width} tabIndex={0}
                onPointerDown={event => { if (event.button !== 0) return; setResizing(true); event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerMove={event => { if (resizing) resize(event.clientX); }}
                onPointerUp={event => { setResizing(false); event.currentTarget.releasePointerCapture(event.pointerId); }}
                onLostPointerCapture={() => setResizing(false)} onPointerCancel={() => setResizing(false)}
                onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); resize(width + (event.key === "ArrowLeft" ? -16 : 16)); } }}/>
        </aside>
    </>;
}
