import {useCallback, useEffect, useRef, useState} from "react";
import {ApiError, errorMessage, readStream, request, type StreamEvent} from "./api";
import {deriveTitle, newId, updateSession} from "./history";
import {defaultPreferences, type Preferences, type UserProfile, type WorkspaceData} from "../../shared/workspace";
import {migrateBrowserData} from "./legacyStorage";
import {applyTurnEvent, finishTurn, turnText} from "./turn";
import {isAccessMode, type AccessMode} from "../../harness/accessMode";
import type {AuthState, Confirmation, Message, Notice, Result, SessionsState, Turn, UploadedFile, Usage} from "./types";

export function useAssistant() {
    const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
    const [profile, setProfile] = useState<UserProfile>();
    const [workspaceReady, setWorkspaceReady] = useState(false);
    const accessMode = preferences.accessMode;
    const preferenceWrites = useRef(Promise.resolve());
    const pendingPreferences = useRef(0);
    const selectionWrites = useRef(Promise.resolve());
    const revision = useRef("");
    const [history, setHistory] = useState<SessionsState>(() => ({activeId: newId(), sessions: [], deletedSessionIds: []}));
    const historyRef = useRef(history);
    const [authenticated, setAuthenticated] = useState(false);
    const authenticatedRef = useRef(false);
    const [authChecked, setAuthChecked] = useState(false);
    const [auth, setAuthState] = useState<AuthState | null>(null);
    const authRef = useRef(auth);
    const [authBusy, setAuthBusy] = useState(false);
    const [loginPending, setLoginPending] = useState(false);
    const [uiLocked, setUiLocked] = useState(false);
    const [lifecycle, setLifecycle] = useState<"offline" | "shutdown" | null>(null);
    const [turn, setTurn] = useState<Turn | null>(null);
    const [stopping, setStopping] = useState(false);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [confirmBusy, setConfirmBusy] = useState(false);
    const [results, setResults] = useState<Result[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [vision, setVision] = useState(false);
    const [notices, setNotices] = useState<Notice[]>([]);
    const chatAbort = useRef<AbortController | null>(null);
    const loginAbort = useRef<AbortController | null>(null);
    const cancellation = useRef<Promise<unknown> | null>(null);
    const lastQuestion = useRef<{question: string; images: string[]; messageId?: string} | null>(null);
    const noticeTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

    function changeAccessMode(mode: AccessMode) {
        if (chatAbort.current || loginAbort.current || confirmBusy || !isAccessMode(mode)) return;
        changePreferences({accessMode: mode});
    }

    const notify = useCallback((message: string, type: Notice["type"] = "info") => {
        const id = newId();
        setNotices(prev => [...prev.slice(-2), {id, message, type}]);
        noticeTimers.current.push(setTimeout(() => setNotices(prev => prev.filter(n => n.id !== id)), 3600));
    }, []);

    const commit = useCallback((update: (state: SessionsState) => SessionsState) => {
        const next = update(historyRef.current);
        historyRef.current = next;
        setHistory(historyRef.current);
    }, []);

    const setAuth = useCallback((next: AuthState | null) => {
        authRef.current = next;
        setAuthState(next);
        setAuthBusy(false);
    }, []);

    const setLoggedIn = useCallback((value: boolean) => {
        authenticatedRef.current = value;
        setAuthenticated(value);
    }, []);

    const openLogin = useCallback(() => {
        if (loginAbort.current || chatAbort.current) return;
        setAuth({phase: "login", origin: "login", message: "使用清华 Info 账号连接校园服务。"});
    }, [setAuth]);

    const handleAuth = useCallback((data: Record<string, unknown>) => {
        const current = authRef.current;
        const origin = current?.origin ?? (loginAbort.current ? "login" : "chat");
        if (data.phase === "success") {
            setLoggedIn(true);
            setAuth(null);
            notify("已连接清华 Info", "success");
        } else if (data.phase === "error") {
            setLoggedIn(false);
            setAuth({phase: "login", origin: "login", message: String(data.message || "认证失败，请重新登录。"), error: true});
        } else if (data.phase === "method" || data.phase === "code") {
            setAuth({
                phase: data.phase, origin, id: String(data.id ?? current?.id ?? ""),
                methods: Array.isArray(data.methods) ? data.methods.filter((m): m is string => typeof m === "string") : undefined,
                phone: typeof data.phone === "string" ? data.phone : undefined,
                message: data.phase === "method" ? "选择一种方式验证你的身份。" : "输入验证码，完成身份验证。",
            });
        }
    }, [notify, setAuth, setLoggedIn]);

    async function startLogin(username: string, password: string) {
        if (loginAbort.current || !username.trim() || !password) return;
        const controller = new AbortController();
        loginAbort.current = controller;
        setLoginPending(true);
        setAuthBusy(true);
        try {
            const response = await request("/api/auth/login", {username: username.trim(), password}, controller.signal);
            await readStream(response, ({event, data}) => { if (event === "auth") handleAuth(data); });
            await checkAuth();
        } catch (e) {
            if (!controller.signal.aborted) setAuth({phase: "login", origin: "login", message: errorMessage(e), error: true});
        } finally {
            loginAbort.current = null;
            setLoginPending(false);
            setAuthBusy(false);
        }
    }

    async function cancelAuth() {
        const id = authRef.current?.id;
        loginAbort.current?.abort();
        setAuth(null);
        if (id) await request("/api/auth/cancel", {id}).catch(() => {});
    }

    async function submitAuth(value: string) {
        const current = authRef.current;
        if (!current?.id || authBusy) return;
        setAuthBusy(true);
        try {
            const method = current.phase === "method";
            await request(method ? "/api/auth/method" : "/api/auth/code", {id: current.id, ...(method ? {method: value} : {code: value})});
        } catch (e) {
            if (authRef.current) setAuth({...authRef.current, error: true, message: errorMessage(e)});
        } finally { setAuthBusy(false); }
    }

    async function unlock(token: string) {
        await request("/api/ui/auth", {token});
        setUiLocked(false);
        await checkAuth();
    }

    const applyWorkspace = useCallback((data: WorkspaceData, initial = false) => {
        setLoggedIn(data.authenticated);
        setProfile(data.profile);
        if (!pendingPreferences.current) setPreferences(data.preferences);
        if (!chatAbort.current) {
            const local = historyRef.current;
            const activeId = !initial && local.activeId && !data.history.deletedSessionIds.includes(local.activeId)
                ? local.activeId : data.history.activeId || newId();
            commit(() => ({...data.history, activeId}));
            setResults(data.history.sessions.find(session => session.id === activeId)?.results ?? []);
        }
        revision.current = data.revision;
        setWorkspaceReady(true);
    }, [commit, setLoggedIn]);

    const checkAuth = useCallback(async () => {
        try {
            let data = await (await request("/api/workspace")).json() as WorkspaceData;
            await migrateBrowserData(data.authenticated);
            data = await (await request("/api/workspace")).json() as WorkspaceData;
            applyWorkspace(data, true);
        } catch (e) {
            if (e instanceof ApiError && e.status === 403) setUiLocked(true);
            else notify("无法读取或迁移已保存的数据，请检查后台连接后刷新。", "error");
        } finally { setAuthChecked(true); }
    }, [applyWorkspace, notify]);

    function changePreferences(patch: Partial<Preferences>) {
        if (!workspaceReady) return;
        setPreferences(current => ({...current, ...patch}));
        pendingPreferences.current++;
        preferenceWrites.current = preferenceWrites.current.then(async () => {
            try { await request("/api/workspace/preferences", patch); }
            catch { notify("设置未能保存到后台，请重试。", "error"); }
            finally { pendingPreferences.current--; }
        });
    }

    function selectRemote(id: string) {
        if (!authenticatedRef.current) return;
        selectionWrites.current = selectionWrites.current.then(async () => {
            try { await request("/api/workspace/select", {activeId: id}); }
            catch { notify("对话位置未能保存，请检查后台连接。", "error"); }
        });
    }

    useEffect(() => {
        void checkAuth();
        let stopped = false;
        let misses = 0;
        let checking = false;
        let polling = false;
        const events = new EventSource("/api/events");
        events.addEventListener("shutdown", () => {
            stopped = true;
            setLifecycle("shutdown");
            events.close();
            chatAbort.current?.abort();
            window.setTimeout(() => window.close(), 250);
        });
        const checkBackend = async () => {
            if (stopped || checking) return;
            checking = true;
            try {
                const data = await (await request("/api/capabilities")).json() as {vision: boolean};
                if (!stopped) { misses = 0; setLifecycle(null); setVision(data.vision === true); }
            } catch {
                if (++misses >= 2 && !stopped) setLifecycle("offline");
            } finally { checking = false; }
        };
        events.onerror = () => { void checkBackend(); };
        void checkBackend();
        const backendTimer = setInterval(() => void checkBackend(), 3000);
        const poll = async () => {
            if (polling || !authenticatedRef.current || stopped) return;
            polling = true;
            try {
                const data = await (await request("/api/notifications")).json() as {notifications?: {id?: string; title: string; message: string; sessionId?: string}[]};
                for (const n of data.notifications ?? []) {

                    notify(`${n.title}：${n.message}`, "success");
                    if ("Notification" in window && Notification.permission === "granted") new Notification(`清灵 · ${n.title}`, {body: n.message});
                }
            } catch { /* Retry next poll. */ } finally { polling = false; }
        };
        const notificationTimer = setInterval(() => void poll(), 30000);
        const firstPoll = setTimeout(() => void poll(), 1200);
        let refreshing = false;
        const refresh = async () => {
            if (refreshing || stopped || chatAbort.current || loginAbort.current || pendingPreferences.current) return;
            refreshing = true;
            try {
                const data = await (await request(`/api/workspace?revision=${revision.current}`)).json() as WorkspaceData & {unchanged?: boolean};
                if (!chatAbort.current && !data.unchanged) applyWorkspace(data);
            } catch { /* Keep the current in-memory view until the backend reconnects. */ }
            finally { refreshing = false; }
        };
        const workspaceTimer = setInterval(() => void refresh(), 1500);
        window.addEventListener("focus", refresh);
        if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
            void navigator.serviceWorker.register("/service-worker.js").catch(() => {});
        }
        return () => {
            stopped = true;
            events.close();
            clearInterval(backendTimer);
            clearInterval(notificationTimer);
            clearTimeout(firstPoll);
            noticeTimers.current.forEach(clearTimeout);
            clearInterval(workspaceTimer);
            window.removeEventListener("focus", refresh);
            chatAbort.current?.abort();
            loginAbort.current?.abort();
        };
    }, [checkAuth, commit, notify, applyWorkspace]);

    async function generate(question: string, images: string[], retryId?: string) {
        if (chatAbort.current || loginAbort.current) return;
        const sessionId = historyRef.current.activeId;
        const messageId = retryId ?? newId();
        const turnAccessMode = accessMode;
        const controller = new AbortController();
        chatAbort.current = controller;
        lastQuestion.current = {question, images, messageId};
        setError(null);
        setResults([]);
        let currentTurn: Turn = {sessionId, messageId, startedAt: Date.now(), status: "running", phase: "thinking", items: []};
        setTurn(currentTurn);
        let text = "";
        let usage: Usage | undefined;
        let finalAnswer = false;
        const updateBot = () => {
            commit(state => updateSession(state, sessionId, session => {
                const message: Message = {id: messageId, role: "bot", text, usage, turn: currentTurn};
                const exists = session.messages.some(m => m.id === messageId);
                return {...session, messages: exists ? session.messages.map(m => m.id === messageId ? message : m) : [...session.messages, message]};
            }));
        };
        updateBot();
        const eventHandler = ({event, data}: StreamEvent) => {
            const nextTurn = applyTurnEvent(currentTurn, {event, data});
            if (nextTurn !== currentTurn) {
                currentTurn = nextTurn;
                text = turnText(currentTurn);
                setTurn(currentTurn);
                updateBot();
            }
            if (event === "confirm") {
                setConfirmation({kind: "write", id: String(data.id), name: String(data.name), args: (data.args ?? {}) as Record<string, unknown>});
            } else if (event === "auth") handleAuth(data);
            else if (event === "qr") setResults(prev => [...prev, {id: newId(), kind: "qr", url: String(data.url), dataUrl: data.dataUrl as string | undefined}]);
            else if (event === "payform") setResults(prev => [...prev, {id: newId(), kind: "payform", html: String(data.html)}]);
            else if (event === "calendar") setResults(prev => [...prev, {id: newId(), kind: "calendar", title: String(data.title), filename: String(data.filename), icsContent: String(data.icsContent)}]);
            else if (event === "answer") {
                finalAnswer = true;
            } else if (event === "usage") {
                usage = data as unknown as Usage;
                if (text) updateBot();
            } else if (event === "error") {
                setError("这次请求未能完成，请稍后重试。");
            }
        };
        try {
            await selectionWrites.current;
            const userMessage = historyRef.current.sessions.find(s => s.id === sessionId)?.messages.findLast(m => m.role === "user");
            const response = await request("/api/chat", {question, sessionId, messageId, userMessageId: userMessage?.id,
                displayQuestion: userMessage?.text, retry: Boolean(retryId), accessMode: turnAccessMode, ...(images.length ? {images} : {})}, controller.signal);
            await readStream(response, eventHandler);
            if (currentTurn.status === "running") {
                currentTurn = finishTurn(currentTurn, "error");
                setError("连接已中断，已保留收到的内容，可以重试。");
            }
        } catch (e) {
            if (currentTurn.status === "running") currentTurn = finishTurn(currentTurn, controller.signal.aborted ? "cancelled" : "error");
            if (currentTurn.status === "completed") { /* The done event already committed this response. */ }
            else if (controller.signal.aborted) notify("已停止生成");
            else if (e instanceof ApiError && e.status === 401) {
                setLoggedIn(false);
                setAuth({phase: "login", origin: "login", message: "登录已过期，请重新连接清华 Info。"});
            } else if (e instanceof ApiError && e.status === 403) setUiLocked(true);
            else setError(errorMessage(e));
        } finally {
            if (cancellation.current) await cancellation.current;
            cancellation.current = null;
            updateBot();
            commit(state => updateSession(state, sessionId, session => ({...session,
                messages: session.messages.filter(m => m.id !== messageId || Boolean(m.text) || Boolean(m.turn?.items.length)),
                tokens: (session.tokens ?? 0) + (usage?.totalTokens ?? 0),
            })));
            try { await request("/api/workspace/history", {history: historyRef.current}); }
            catch { notify("对话同步失败，已收到的内容暂保留在当前页面。", "error"); }
            setTurn(null);
            setStopping(false);
            setConfirmation(prev => prev?.kind === "write" ? null : prev);
            chatAbort.current = null;
            if (authRef.current?.origin === "chat") setAuth(null);
        }
        if (finalAnswer && currentTurn.status === "completed") {
            const session = historyRef.current.sessions.find(s => s.id === sessionId);
            if (session && !session.titleLlm) {
                commit(state => updateSession(state, sessionId, s => ({...s, titleLlm: true})));
                void request("/api/session/title", {sessionId}).then(r => r.json()).then((data: {title?: string}) => {
                    if (data.title && !historyRef.current.deletedSessionIds.includes(sessionId)) {
                        commit(state => updateSession(state, sessionId, s => ({...s, title: data.title!})));
                    }
                }).catch(() => {});
            }
        }
        return finalAnswer && currentTurn.status === "completed" ? text : undefined;
    }

    async function send(question: string, images: string[] = [], files: UploadedFile[] = []) {
        if ((!question.trim() && !images.length && !files.length) || chatAbort.current || loginAbort.current || lifecycle) return;
        if (!authenticatedRef.current) { openLogin(); return; }
        const sessionId = historyRef.current.activeId;
        const display = [question.trim(), ...(files.length ? [`📎 ${files.map(file => file.name).join("、")}`] : [])].filter(Boolean).join("\n");
        const agentText = files.length ? files.map(file =>
            `（用户已上传文件「${file.name}」，保存在本机路径：${file.path}。需要本地文件路径的工具（如 submit_learn_homework 的 filePath）可直接使用该路径。）`,
        ).join("\n") + "\n\n" + (question.trim() || "（用户上传了上述文件，请结合对话确认它的用途。）") : question.trim();
        commit(state => updateSession(state, sessionId, session => {
            const messages: Message[] = [...session.messages, {id: newId(), role: "user", text: display, images, imageCount: images.length}];
            return {...session, messages, title: session.title === "新对话" ? deriveTitle(messages) : session.title};
        }));
        return generate(agentText, images);
    }

    function stop() {
        if (!chatAbort.current || cancellation.current) return;
        setStopping(true);
        chatAbort.current.abort();
        cancellation.current = request("/api/chat/cancel", {}).catch(() => {});
    }

    function retry() {
        const last = lastQuestion.current;
        if (last && authenticatedRef.current) return generate(last.question, last.images, last.messageId);
        const session = historyRef.current.sessions.find(s => s.id === historyRef.current.activeId);
        const user = session?.messages.findLast(m => m.role === "user");
        const bot = session?.messages.findLast(m => m.role === "bot");
        if (user && authenticatedRef.current) return generate(user.text, user.images ?? [], bot?.id);
    }

    function switchSession(id: string) {
        if (chatAbort.current || loginAbort.current) { notify("请等待当前操作完成"); return; }
        if (!authenticatedRef.current) return;
        commit(state => ({...state, activeId: id}));
        selectRemote(id);
        setError(null);
        setResults([]);
        lastQuestion.current = null;
    }

    function newChat() {
        if (chatAbort.current || loginAbort.current) { notify("请等待当前操作完成"); return; }
        const id = newId();
        commit(state => ({...state, activeId: id}));
        selectRemote(id);
        setError(null);
        setResults([]);
        lastQuestion.current = null;
    }

    function requestConfirmation(action: Confirmation) {
        if (chatAbort.current || loginAbort.current || confirmBusy) return;
        if (accessMode === "full-access" && action.kind !== "write") void performConfirmedAction(action, true);
        else setConfirmation(action);
    }

    async function respond(approved: boolean) {
        if (confirmation) await performConfirmedAction(confirmation, approved);
    }

    async function performConfirmedAction(confirmation: Confirmation, approved: boolean) {
        if (confirmBusy) return;
        setConfirmBusy(true);
        try {
            if (confirmation.kind === "write") await request("/api/confirm", {id: confirmation.id, approved});
            else if (approved && confirmation.kind === "logout") {
                await request("/api/auth/logout", {});
                commit(state => state);
                setLoggedIn(false);
                setProfile(undefined);
                setResults([]);
                setError(null);
                notify("已退出登录，历史对话将在下次登录后恢复", "success");
            } else if (approved && confirmation.kind === "delete") {
                const id = confirmation.session.id;
                await request("/api/session/destroy", {sessionId: id});
                commit(state => ({...state, deletedSessionIds: [...state.deletedSessionIds, id], sessions: state.sessions.filter(s => s.id !== id)}));
                setResults([]);
                setError(null);
            }
            setConfirmation(null);
        } catch (e) { notify(errorMessage(e), "error"); }
        finally { setConfirmBusy(false); }
    }

    const session = history.sessions.find(s => s.id === history.activeId);
    return {preferences, changePreferences, profile, workspaceReady, history, session, messages: authenticated ? session?.messages ?? [] : [], authenticated, authChecked, accessMode, changeAccessMode,
        auth, authBusy, loginPending, uiLocked, lifecycle, turn, stopping, confirmation, confirmBusy, results, error, vision, notices,
        notify, openLogin, startLogin, cancelAuth, submitAuth, unlock, send, stop, retry, switchSession, newChat, respond, requestConfirmation};
}

export type Assistant = ReturnType<typeof useAssistant>;
