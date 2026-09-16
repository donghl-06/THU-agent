import {getBuiltinModule} from "node:process";
import type {DatabaseSync as SqliteDatabase} from "node:sqlite";
import {chmodSync, mkdirSync, readFileSync} from "node:fs";
import {dirname} from "node:path";
import {randomUUID} from "node:crypto";
import {defaultPreferences, validPreferences, type Preferences, type UserProfile} from "../shared/workspace";
import {mergeHistory, mergeMessages, newId, parseHistory, updateSession} from "../web/lib/history";
import {finishTurn} from "../web/lib/turn";
import type {Session, SessionsState} from "../web/lib/types";
import type {ChatMessage} from "../harness/types";
import {SessionStore} from "./sessionStore";

const {DatabaseSync} = getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/** A local, single-user database. Browser state is only an in-memory view. */
export class WebDatabase {
    private readonly db: SqliteDatabase;
    private readonly instance = randomUUID();
    private version = 0;
    get revision() { return `${this.instance}:${this.version}`; }

    constructor(path = ":memory:", legacySessionsPath?: string) {
        if (path !== ":memory:") mkdirSync(dirname(path), {recursive: true});
        this.db = new DatabaseSync(path);
        if (path !== ":memory:") chmodSync(path, 0o600);
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        this.db.exec("CREATE TABLE IF NOT EXISTS attachments (path TEXT PRIMARY KEY, name TEXT NOT NULL, bytes BLOB NOT NULL)");
        if (!this.get<SessionsState>("history")) this.put("history", {activeId: newId(), sessions: [], deletedSessionIds: []});
        // Interrupted processes retain their timeline and never appear to still be generating.
        this.saveHistory(state => ({...state, sessions: state.sessions.map(session => ({...session, messages: session.messages.map(message =>
            message.turn?.status === "running" ? {...message, turn: finishTurn(message.turn, "error")} : message)}))}));
        if (legacySessionsPath && !this.get("legacy-context-imported")) {
            try {
                const entries = JSON.parse(readFileSync(legacySessionsPath, "utf8")) as Record<string, ChatMessage[]>;
                this.transaction(() => {
                    for (const [id, messages] of Object.entries(entries)) {
                        if (Array.isArray(messages) && !this.get(`context:${id}`)) this.setContext(id, messages);
                    }
                    this.put("legacy-context-imported", true);
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
    }

    get<T>(key: string): T | undefined {
        const row = this.db.prepare("SELECT value FROM documents WHERE key = ?").get(key) as {value: string} | undefined;
        return row ? JSON.parse(row.value) as T : undefined;
    }

    put(key: string, value: unknown) {
        this.db.prepare("INSERT INTO documents (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
        this.version++;
    }

    private transaction(action: () => void) {
        this.db.exec("BEGIN IMMEDIATE");
        try { action(); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }

    history(): SessionsState { return this.get<SessionsState>("history")!; }
    preferences(): Preferences { return {...defaultPreferences, ...this.get<Partial<Preferences>>("preferences")}; }
    profile(): UserProfile | undefined { return this.get<UserProfile>("profile"); }
    savePreferences(value: unknown) {
        this.put("preferences", {...this.get("preferences") as Partial<Preferences>, ...validPreferences(value)});
    }
    saveHistory(update: (history: SessionsState) => SessionsState) { this.put("history", update(this.history())); }
    updateSession(id: string, update: (session: Session) => Session) {
        this.saveHistory(state => state.deletedSessionIds.includes(id) ? state : updateSession(state, id, update));
    }
    selectSession(id: string) { this.saveHistory(state => ({...state, activeId: id})); }
    importBrowser(history: unknown, preferences: unknown) {
        if (history !== undefined && (!history || typeof history !== "object" || !Array.isArray((history as SessionsState).sessions))) throw new Error("Invalid history");
        const incoming = history === undefined ? undefined : parseHistory(JSON.stringify(history));
        const settings = validPreferences(preferences ?? {});
        this.transaction(() => {
            if (incoming) {
                const saved = this.history();
                const merged = mergeHistory(saved, incoming);
                // Existing server messages are authoritative; imports only fill missing messages.
                merged.sessions = merged.sessions.map(session => {
                    const current = saved.sessions.find(item => item.id === session.id);
                    return current ? {...session, messages: mergeMessages(session.messages, current.messages, session.id)} : session;
                });
                if (!saved.sessions.length) merged.activeId = incoming.activeId;
                this.put("history", merged);
                for (const session of incoming.sessions) {
                    if (merged.deletedSessionIds.includes(session.id) || this.getContext(session.id)) continue;
                    this.setContext(session.id, session.messages.filter(message => message.text).map(message => ({
                        role: message.role === "user" ? "user" : "assistant", content: message.text,
                    })));
                }
            }
            // Existing database preferences win over an old browser's copy.
            this.put("preferences", {...settings, ...this.get<Partial<Preferences>>("preferences")});
        });
    }
    deleteSession(id: string) {
        this.transaction(() => {
            this.db.prepare("DELETE FROM documents WHERE key = ?").run(`context:${id}`);
            this.saveHistory(state => {
                const sessions = state.sessions.filter(session => session.id !== id);
                return {...state, sessions, deletedSessionIds: [...new Set([...state.deletedSessionIds, id])],
                    activeId: state.activeId === id ? sessions[0]?.id ?? newId() : state.activeId};
            });
        });
    }
    clearSessions() {
        this.transaction(() => {
            const contexts = this.db.prepare("SELECT key FROM documents WHERE key GLOB 'context:*'").all() as {key: string}[];
            this.db.exec("DELETE FROM documents WHERE key GLOB 'context:*'");
            this.saveHistory(state => ({activeId: newId(), sessions: [], deletedSessionIds: [...new Set([
                ...state.deletedSessionIds, ...state.sessions.map(session => session.id), ...contexts.map(row => row.key.slice(8)),
            ])]}));
        });
    }
    getContext(id: string): ChatMessage[] | undefined { return this.get(`context:${id}`); }
    setContext(id: string, messages: ChatMessage[]) { this.put(`context:${id}`, SessionStore.sanitize(messages)); }
    saveAttachment(path: string, name: string, bytes: Buffer) {
        this.db.prepare("INSERT INTO attachments (path, name, bytes) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET name = excluded.name, bytes = excluded.bytes").run(path, name, bytes);
    }
    close() { this.db.close(); }
}
