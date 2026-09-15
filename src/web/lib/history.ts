import type {Message, Session, SessionsState} from "./types";

export const SESSIONS_KEY = "thu-assistant-sessions-v1";
const LEGACY_KEY = "thu-assistant-chat-v1";
const MAX_MESSAGES = 100;
export const newId = () => `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
export const storage = {
    get(key: string, fallback: string) {
        try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    },
    set(key: string, value: string) {
        try { localStorage.setItem(key, value); } catch { /* Private mode / storage quota. */ }
    },
};

export function normalizeMessages(records: Partial<Message>[], sessionId: string): Message[] {
    const byId = new Map<string, Message>();
    const occurrences = new Map<string, number>();
    for (const source of records) {
        if (!source || !["user", "bot"].includes(source.role ?? "") || typeof source.text !== "string") continue;
        if (!source.text && (source.role === "bot" || !source.imageCount)) continue;
        const key = `${source.role}\u0000${source.text}\u0000${source.imageCount ?? 0}`;
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        let hash = 2166136261;
        for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
        const prefix = `${sessionId}:legacy:`;
        const rawId = source.id ?? "";
        const oldIndexedId = rawId.startsWith(prefix) && !/^[0-9a-z]+:[1-9][0-9]*$/.test(rawId.slice(prefix.length));
        const id = rawId && !oldIndexedId ? rawId : `${prefix}${(hash >>> 0).toString(36)}:${occurrence}`;
        byId.set(id, {...source, id, role: source.role as Message["role"], text: source.text.slice(0, 20000)});
    }
    return [...byId.values()].slice(-MAX_MESSAGES);
}

// Preserve additions from both tabs, and replace a partial answer with its newer version.
export function mergeMessages(older: Message[], newer: Message[], sessionId: string): Message[] {
    const a = normalizeMessages(older, sessionId);
    const b = normalizeMessages(newer, sessionId);
    const dp = Array.from({length: a.length + 1}, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            dp[i][j] = a[i].id === b[j].id ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const merged: Message[] = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        if (a[i].id === b[j].id) { merged.push(b[j++]); i++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) merged.push(a[i++]);
        else merged.push(b[j++]);
    }
    return [...merged, ...a.slice(i), ...b.slice(j)].slice(-MAX_MESSAGES);
}

export function parseHistory(raw: string): SessionsState {
    try {
        const parsed = JSON.parse(raw) as SessionsState;
        if (!Array.isArray(parsed.sessions)) throw new Error("Invalid history");
        const deletedSessionIds = Array.isArray(parsed.deletedSessionIds) ? parsed.deletedSessionIds.filter(id => typeof id === "string") : [];
        const sessions = parsed.sessions.filter(s => s && typeof s.id === "string" && !deletedSessionIds.includes(s.id)).map(s => ({
            ...s,
            title: typeof s.title === "string" ? s.title : "新对话",
            createdAt: Number(s.createdAt) || Date.now(),
            messages: normalizeMessages(Array.isArray(s.messages) ? s.messages : [], s.id),
        }));
        return {sessions, deletedSessionIds, activeId: sessions.some(s => s.id === parsed.activeId) ? parsed.activeId : sessions[0]?.id ?? newId()};
    } catch { return {sessions: [], activeId: newId(), deletedSessionIds: []}; }
}

export function readHistory(): SessionsState {
    const state = parseHistory(storage.get(SESSIONS_KEY, ""));
    if (!state.sessions.length) {
        try {
            const legacy = JSON.parse(storage.get(LEGACY_KEY, "[]")) as Message[];
            if (Array.isArray(legacy) && legacy.length) {
                const messages = normalizeMessages(legacy, state.activeId);
                state.sessions.push({id: state.activeId, title: deriveTitle(messages), createdAt: Date.now(), messages});
            }
        } catch { /* Ignore malformed legacy storage. */ }
    }
    return state;
}

export function mergeHistory(local: SessionsState, remote: SessionsState): SessionsState {
    const deletedSessionIds = [...new Set([...local.deletedSessionIds, ...remote.deletedSessionIds])];
    const byId = new Map<string, Session>();
    for (const session of [...local.sessions, ...remote.sessions]) {
        if (deletedSessionIds.includes(session.id)) continue;
        const prev = byId.get(session.id);
        if (!prev) { byId.set(session.id, {...session}); continue; }
        const localNewer = (prev.updatedAt ?? prev.createdAt) > (session.updatedAt ?? session.createdAt);
        byId.set(session.id, {
            ...prev,
            title: prev.title && prev.title !== "新对话" ? prev.title : session.title,
            titleLlm: prev.titleLlm || session.titleLlm,
            messages: mergeMessages(localNewer ? session.messages : prev.messages, localNewer ? prev.messages : session.messages, session.id),
            tokens: Math.max(prev.tokens ?? 0, session.tokens ?? 0),
            updatedAt: Math.max(prev.updatedAt ?? prev.createdAt, session.updatedAt ?? session.createdAt),
        });
    }
    const sessions = [...byId.values()];
    return {sessions, deletedSessionIds, activeId: byId.has(local.activeId) ? local.activeId : sessions[0]?.id ?? local.activeId};
}

export function persistHistory(state: SessionsState): SessionsState {
    const merged = mergeHistory(state, readHistory());
    merged.sessions = merged.sessions.sort((a, b) => b.createdAt - a.createdAt).filter((s, i) => i < 29 || s.id === merged.activeId);
    const saved = {...merged, sessions: merged.sessions.map(s => ({...s, messages: s.messages.map(({images, ...m}) => ({...m, imageCount: images?.length || m.imageCount}))}))};
    storage.set(SESSIONS_KEY, JSON.stringify(saved));
    storage.set(LEGACY_KEY, "[]");
    return merged;
}

export function deriveTitle(messages: Message[]) {
    return messages.find(m => m.role === "user")?.text.trim().slice(0, 18) || "新对话";
}

export function updateSession(state: SessionsState, id: string, update: (session: Session) => Session): SessionsState {
    const current = state.sessions.find(s => s.id === id) ?? {id, title: "新对话", messages: [], createdAt: Date.now()};
    const next = update(current);
    return {...state, sessions: [...state.sessions.filter(s => s.id !== id), {...next, updatedAt: Date.now()}]};
}
