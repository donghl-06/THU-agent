import {useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {AnimatePresence, MotionConfig, motion, useReducedMotion} from "motion/react";
import {ArrowDown, Bell, BellOff, Check, CircleHelp, Info, Moon, PanelLeft, ShieldCheck, Sun, Volume2, VolumeX, X} from "lucide-react";
import {useAssistant} from "./lib/useAssistant";
import {storage} from "./lib/history";
import {Sidebar} from "./components/Sidebar";
import {Composer} from "./components/Composer";
import {Welcome} from "./components/Welcome";
import {Dialogs} from "./components/Dialogs";
import {ErrorNotice, MessageView, ResultView, Thinking} from "./components/Conversation";
import {IconButton} from "./components/Controls";

export default function App() {
    return <MotionConfig reducedMotion="user" transition={{ease: [.22, 1, .36, 1], duration: .25}}><Workspace/></MotionConfig>;
}

function Workspace() {
    const app = useAssistant();
    const [theme, setTheme] = useState(() => storage.get("theme", "light") === "dark" ? "dark" : "light");
    const [sound, setSound] = useState(() => storage.get("snd", "1") === "1");
    const [tts, setTts] = useState(() => storage.get("tts", "0") === "1");
    const [collapsed, setCollapsed] = useState(() => storage.get("sidebar-collapsed", "0") === "1");
    const [mobileOpen, setMobileOpen] = useState(false);
    const [about, setAbout] = useState(false);
    const [draft, setDraft] = useState("");
    const [date, setDate] = useState(() => new Date());
    const [showScroll, setShowScroll] = useState(false);
    const chat = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    const previousTurn = useRef(app.turn);
    const audio = useRef<AudioContext | null>(null);
    const reducedMotion = useReducedMotion();
    const closeMobile = useCallback(() => setMobileOpen(false), []);
    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#17171a" : "#f7f7fa");
        storage.set("theme", theme);
    }, [theme]);
    useEffect(() => { storage.set("sidebar-collapsed", collapsed ? "1" : "0"); }, [collapsed]);
    useEffect(() => { storage.set("snd", sound ? "1" : "0"); }, [sound]);
    useEffect(() => { storage.set("tts", tts ? "1" : "0"); if (!tts) window.speechSynthesis?.cancel(); }, [tts]);
    useEffect(() => {
        const timer = setInterval(() => setDate(new Date()), 60000);
        const resize = () => { if (window.innerWidth > 768) setMobileOpen(false); };
        window.addEventListener("resize", resize);
        return () => { clearInterval(timer); window.removeEventListener("resize", resize); void audio.current?.close(); window.speechSynthesis?.cancel(); };
    }, []);
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !app.turn && !app.loginPending && !document.querySelector("dialog[open]")) {
                event.preventDefault();
                app.newChat();
                setDraft("");
                chat.current?.parentElement?.querySelector("textarea")?.focus();
            }
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    });
    useEffect(() => {
        setDraft("");
        following.current = true;
    }, [app.history.activeId]);
    useLayoutEffect(() => {
        if (app.turn && !previousTurn.current) following.current = true;
        previousTurn.current = app.turn;
        if (following.current && chat.current) { chat.current.scrollTop = chat.current.scrollHeight; setShowScroll(false); }
    }, [app.messages, app.turn, app.error, app.results]);

    function beep() {
        if (!sound) return;
        try {
            audio.current ??= new AudioContext();
            void audio.current.resume();
            const oscillator = audio.current.createOscillator();
            const gain = audio.current.createGain();
            oscillator.frequency.value = 660;
            gain.gain.value = .035;
            oscillator.connect(gain);
            gain.connect(audio.current.destination);
            oscillator.start();
            gain.gain.exponentialRampToValueAtTime(.0001, audio.current.currentTime + .09);
            oscillator.stop(audio.current.currentTime + .09);
        } catch { /* Sound is optional. */ }
    }

    async function send(text: string, images: string[] = []) {
        if (app.turn || app.loginPending) return;
        if (!app.authenticated) { setDraft(text); app.openLogin(); return; }
        setDraft("");
        window.speechSynthesis?.cancel();
        beep();
        following.current = true;
        const answer = await app.send(text, images);
        if (answer && tts && "speechSynthesis" in window) {
            const utterance = new SpeechSynthesisUtterance(answer);
            utterance.lang = "zh-CN";
            window.speechSynthesis.speak(utterance);
        }
    }

    async function copy(text: string) {
        try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
            else {
                const element = document.createElement("textarea");
                element.value = text;
                element.style.cssText = "position:fixed;opacity:0";
                document.body.append(element);
                element.select();
                const copied = document.execCommand("copy");
                element.remove();
                if (!copied) throw new Error("Copy unavailable");
            }
            app.notify("已复制回答", "success");
        } catch { app.notify("复制失败，请选择文字后手动复制", "error"); }
    }

    const empty = !app.messages.length && !app.turn && !app.error;
    const lastBot = app.messages.findLast(m => m.role === "bot");
    return <div className="app-shell">
        <Sidebar app={app} collapsed={collapsed} mobileOpen={mobileOpen} closeMobile={closeMobile} collapse={() => setCollapsed(true)} about={() => setAbout(true)}/>
        <main className="workspace" inert={mobileOpen || undefined}>
            <header className="toolbar">
                <div className="toolbar-leading"><IconButton icon={PanelLeft} label="展开侧栏" className={`sidebar-toggle ${collapsed ? "is-collapsed" : ""}`} onClick={() => window.innerWidth <= 768 ? setMobileOpen(true) : setCollapsed(false)}/><span className="workspace-title">{app.authenticated && !empty ? app.session?.title ?? "新对话" : "校园助手"}</span><span className="toolbar-divider"/><span className="toolbar-date">{date.toLocaleDateString("zh-CN", {month: "long", day: "numeric", weekday: "long"})}</span></div>
                <div className="toolbar-actions"><span className="connection"><span className={`connection-dot ${app.authenticated ? "connected" : ""}`}/>{app.authenticated ? "Info 已连接" : "尚未登录"}</span>
                    <IconButton icon={theme === "dark" ? Sun : Moon} label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}/>
                    <IconButton icon={tts ? Volume2 : VolumeX} label={tts ? "关闭朗读回复" : "开启朗读回复"} aria-pressed={tts} onClick={() => setTts(!tts)}/>
                    <IconButton icon={sound ? Bell : BellOff} label={sound ? "关闭提示音" : "开启提示音"} aria-pressed={sound} onClick={() => setSound(!sound)}/>
                    <IconButton icon={CircleHelp} label="服务指南" className="header-help" onClick={() => setAbout(true)}/>
                    {!app.authenticated && <button className="login-button" onClick={app.openLogin} disabled={app.loginPending}>登录</button>}
                </div>
            </header>
            <div ref={chat} className={`chat-scroll ${empty ? "is-empty" : ""}`} onScroll={() => {
                const element = chat.current;
                if (!element) return;
                following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                setShowScroll(!following.current);
            }}>
                {empty ? <Welcome authenticated={app.authenticated} send={text => void send(text)}/> : <div className="conversation" role="log" aria-label="对话内容" aria-live="off">
                    {app.messages.map(message => <MessageView key={message.id} message={message} streaming={app.turn?.messageId === message.id} copy={text => void copy(text)} retry={!app.turn && message.id === lastBot?.id ? () => void app.retry() : undefined}/>)}
                    <AnimatePresence>{app.turn && <Thinking key={app.turn.messageId} turn={app.turn}/>}</AnimatePresence>
                    {app.error && <ErrorNotice message={app.error} retry={() => void app.retry()} disabled={Boolean(app.turn)}/>}
                    {app.results.map(result => <ResultView key={result.id} result={result}/>)}
                </div>}
            </div>
            <div className="composer-dock">
                <AnimatePresence>{showScroll && <motion.button className="scroll-bottom" initial={{opacity: 0, y: 8}} animate={{opacity: 1, y: 0}} exit={{opacity: 0, y: 8}} aria-label="回到底部" onClick={() => {
                    following.current = true;
                    setShowScroll(false);
                    chat.current?.scrollTo({top: chat.current.scrollHeight, behavior: reducedMotion ? "instant" : "smooth"});
                }}><ArrowDown size={18}/></motion.button>}</AnimatePresence>
                {!empty && <div className="quick-actions">{["今天有什么课", "图书馆座位", "校园卡余额"].map(text => <button key={text} disabled={Boolean(app.turn)} onClick={() => void send(text)}>{text}</button>)}</div>}
                <Composer app={app} value={draft} setValue={setDraft} onSend={(text, images) => void send(text, images)}/>
            </div>
            {empty && <span className="workspace-footnote"><ShieldCheck size={13}/>操作前确认，信息更安心</span>}
        </main>
        <div className="toast-stack" role="status" aria-live="polite"><AnimatePresence>{app.notices.map(notice => <motion.div key={notice.id} className={`toast ${notice.type}`} initial={{opacity: 0, y: -10, scale: .96}} animate={{opacity: 1, y: 0, scale: 1}} exit={{opacity: 0, y: -8, scale: .96}}>{notice.type === "success" ? <Check size={17}/> : notice.type === "error" ? <X size={17}/> : <Info size={17}/>}<span>{notice.message}</span></motion.div>)}</AnimatePresence></div>
        <Dialogs app={app} about={about} closeAbout={() => setAbout(false)}/>
    </div>;
}
