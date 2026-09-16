import {useState, type FormEvent} from "react";
import {AnimatePresence} from "motion/react";
import {ArrowUpRight, BookOpen, CalendarDays, Check, Hand, KeyRound, LoaderCircle, LockKeyhole, LogOut, MessageCircle, Newspaper, Power, ShieldAlert, Smartphone, Trash2, Unplug, Volleyball} from "lucide-react";
import tsinghuaEmblem from "../assets/tsinghua-emblem.jpg";
import type {Assistant} from "../lib/useAssistant";
import {toolLabels} from "../lib/api";
import {Modal} from "./Modal";
import {Brand} from "./Controls";

export function Dialogs({app, about, closeAbout}: {app: Assistant; about: boolean; closeAbout: () => void}) {
    return <AnimatePresence>
        {about && <Modal key="about" title="关于清灵" close={closeAbout} className="about-modal"><Brand large/><h3>清灵 <span>QingLing</span></h3><p>你的清华校园智能助手</p><div className="about-services">{[
            {icon: CalendarDays, label: "课程与日程", text: "查课表、成绩，寻找空闲时间"},
            {icon: BookOpen, label: "图书馆", text: "查空位、预约座位与研讨间"},
            {icon: Newspaper, label: "校园资讯", text: "浏览校园动态和通知详情"},
            {icon: Volleyball, label: "体育与生活", text: "场馆预约、校园卡、宿舍电费"},
        ].map(({icon: Icon, label, text}) => <div key={label}><Icon size={19}/><span><strong>{label}</strong><small>{text}</small></span></div>)}</div><p className="privacy-note">{app.accessMode === "full-access" ? <><ShieldAlert size={15}/>完全访问：操作将直接执行</> : <><Hand size={15}/>请求批准：操作前由你确认</>}</p><button className="button primary full" onClick={closeAbout}>开始使用<ArrowUpRight size={16}/></button></Modal>}
        {app.auth && <AuthDialog key="auth" app={app}/>}
        {app.confirmation && <ConfirmDialog key="confirmation" app={app}/>}
        {app.uiLocked && <AccessDialog key="access" app={app}/>}
        {app.lifecycle && <Modal key="lifecycle" title={app.lifecycle === "shutdown" ? "清灵已退出" : "清灵后台未运行"} className="lifecycle-modal"><span className="dialog-icon">{app.lifecycle === "shutdown" ? <Power/> : <Unplug/>}</span><p>请重新启动清灵本地服务，然后回来继续对话。</p><button className="button primary full" onClick={() => location.reload()}>重新连接</button></Modal>}
    </AnimatePresence>;
}

function AuthDialog({app}: {app: Assistant}) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const auth = app.auth!;
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (auth.phase === "code") { const value = code; setCode(""); await app.submitAuth(value); }
        else { const value = password; setPassword(""); await app.startLogin(username, value); }
    };
    const methods = [
        {id: "totp", icon: KeyRound, title: "验证器动态码", detail: "输入验证器中的当前验证码"},
        {id: "mobile", icon: Smartphone, title: "短信验证码", detail: "发送到已绑定的手机号"},
        {id: "wechat", icon: MessageCircle, title: "微信验证", detail: "使用已关联的清华身份认证"},
    ];
    return <Modal title={auth.phase === "login" ? "连接清华 Info" : "验证你的身份"} titleAccessory={auth.phase === "login" ? <span className="tsinghua-emblem" aria-hidden="true"><img src={tsinghuaEmblem} alt="" width="1400" height="600"/></span> : undefined} close={() => void app.cancelAuth()} className="auth-modal">
        <p className={auth.error ? "form-error" : "dialog-description"} role={auth.error ? "alert" : "status"}>{auth.message}</p>
        <form onSubmit={event => void submit(event)}>
            {auth.phase === "login" && <div className="form-fields"><label>学号<input autoFocus autoComplete="username" inputMode="numeric" placeholder="输入学号" maxLength={128} value={username} onChange={e => setUsername(e.target.value)} required/></label><label>密码<input type="password" autoComplete="current-password" placeholder="输入密码" maxLength={512} value={password} onChange={e => setPassword(e.target.value)} required/></label><p className="field-note">凭证只发送至本机服务。本机会话可能被登记为可信设备，可在清华身份认证页面撤销。</p></div>}
            {auth.phase === "method" && <div className="auth-methods">{auth.phone && <p className="field-note">短信将发送至 {auth.phone}</p>}{methods.filter(m => auth.methods?.includes(m.id)).map(({id, icon: Icon, title, detail}) => <button className="auth-method" type="button" disabled={app.authBusy} key={id} onClick={() => void app.submitAuth(id)}><Icon size={22}/><span><strong>{title}</strong><small>{detail}</small></span><ArrowUpRight size={16}/></button>)}</div>}
            {auth.phase === "code" && <label className="code-label">验证码<input autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="输入验证码" maxLength={128} required value={code} onChange={e => setCode(e.target.value)}/></label>}
            <div className="modal-actions"><button type="button" className="button secondary" onClick={() => void app.cancelAuth()}>取消</button>{auth.phase !== "method" && <button className="button primary" disabled={app.authBusy || (auth.phase === "login" && app.loginPending)}>{app.authBusy ? <LoaderCircle className="spin" size={16}/> : <LockKeyhole size={15}/>}<span>{app.authBusy ? "正在连接" : auth.phase === "code" ? "提交验证码" : "登录"}</span></button>}</div>
        </form>
    </Modal>;
}

function ConfirmDialog({app}: {app: Assistant}) {
    const confirmation = app.confirmation!;
    const isWrite = confirmation.kind === "write";
    const isDelete = confirmation.kind === "delete";
    const title = isWrite ? "确认这次操作" : isDelete ? "删除对话？" : "退出登录？";
    const Icon = isWrite ? Hand : isDelete ? Trash2 : LogOut;
    return <Modal title={title} close={app.confirmBusy ? undefined : () => void app.respond(false)}>
        <span className={`dialog-icon ${isDelete ? "danger" : ""}`}><Icon size={27}/></span>
        <p className="dialog-description">{isWrite ? "请核对以下信息，确认后清灵才会执行。" : isDelete ? `“${confirmation.session.title}”将被删除，此操作无法撤销。` : "退出后历史对话会隐藏，重新登录即可继续查看。"}</p>
        {isWrite && <dl className="confirmation-details"><div><dt>操作</dt><dd>{toolLabels[confirmation.name] ?? confirmation.name}</dd></div>{Object.entries(confirmation.args).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>}
        <div className="modal-actions"><button className="button secondary" disabled={app.confirmBusy} onClick={() => void app.respond(false)}>取消</button><button className={`button ${isDelete ? "destructive" : "primary"}`} disabled={app.confirmBusy} onClick={() => void app.respond(true)}>{app.confirmBusy ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>}<span>{isWrite ? "确认执行" : isDelete ? "删除对话" : "确认退出"}</span></button></div>
    </Modal>;
}

function AccessDialog({app}: {app: Assistant}) {
    const [token, setToken] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError("");
        try { await app.unlock(token); } catch { setError("口令不正确或连接失败，请重试。"); } finally { setToken(""); setBusy(false); }
    }
    return <Modal title="输入访问口令"><span className="dialog-icon"><LockKeyhole size={28}/></span><p className="dialog-description">此清灵服务已启用访问保护。</p><form onSubmit={event => void submit(event)}><label>访问口令<input autoFocus type="password" placeholder="输入口令" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required/></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy}>{busy && <LoaderCircle className="spin" size={16}/>}进入清灵</button></form></Modal>;
}
