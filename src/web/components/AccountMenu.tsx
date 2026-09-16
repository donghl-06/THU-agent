import {useEffect, useId, useRef, useState} from "react";
import {AnimatePresence, motion} from "motion/react";
import {CircleHelp, Copy, LogOut, UserRound} from "lucide-react";
import type {Assistant} from "../lib/useAssistant";

export function AccountMenu({app, about}: {app: Assistant; about: () => void}) {
    const [open, setOpen] = useState(false);
    const container = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const menuId = useId();
    const disabled = Boolean(app.turn) || app.loginPending || app.confirmBusy;
    const profile = app.profile;
    const name = profile?.name || profile?.username || "清华用户";
    function close(focus = false) { setOpen(false); if (focus) trigger.current?.focus(); }
    useEffect(() => {
        if (!open) return;
        container.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
        window.addEventListener("pointerdown", outside);
        return () => window.removeEventListener("pointerdown", outside);
    }, [open]);
    useEffect(() => { if (!app.authenticated || disabled) setOpen(false); }, [app.authenticated, disabled]);
    return <div className="account-container" ref={container} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
    }} onKeyDown={event => {
        if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); }
        if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) && app.authenticated) {
            event.preventDefault();
            if (!open) { setOpen(true); return; }
            const items = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
            items[next]?.focus();
        }
    }}>
        <AnimatePresence>{open && <motion.div id={menuId} className="account-menu" role="menu" aria-label="账户菜单" initial={{opacity: 0, y: 8}} animate={{opacity: 1, y: 0}} exit={{opacity: 0, y: 5}}>
            <div className="account-details" role="presentation"><strong>{name}</strong>{profile?.username && <span>账号 · {profile.username}</span>}{profile?.email && <small>{profile.email}</small>}</div>
            {profile?.username && <button role="menuitem" tabIndex={-1} onClick={() => {
                close(true);
                void navigator.clipboard.writeText(profile.username).then(() => app.notify("账号已复制", "success"), () => app.notify("复制失败，请重试", "error"));
            }}><Copy size={16}/>复制账号</button>}
            <button role="menuitem" tabIndex={-1} onClick={() => { close(true); about(); }}><CircleHelp size={16}/>校园服务指南</button>
            <div className="account-menu-divider" role="separator"/>
            <button role="menuitem" tabIndex={-1} className="account-logout" onClick={() => { close(true); app.requestConfirmation({kind: "logout"}); }}><LogOut size={16}/>退出登录</button>
        </motion.div>}</AnimatePresence>
        <button ref={trigger} className="account" disabled={disabled} aria-label={app.authenticated ? `账户：${name}` : "连接清华账号"} aria-haspopup={app.authenticated ? "menu" : undefined} aria-expanded={app.authenticated ? open : undefined} aria-controls={open ? menuId : undefined} onClick={() => app.authenticated ? setOpen(!open) : app.openLogin()}>
            <span className="account-avatar">{app.authenticated ? name.slice(0, 1) : <UserRound size={19}/>}</span>
            <span className="account-copy"><strong>{app.authenticated ? name : "连接清华账号"}</strong><small>{app.authenticated ? profile?.username || "清华账号" : "登录，开启校园服务"}</small></span>
        </button>
    </div>;
}
