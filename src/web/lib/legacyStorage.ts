import {request} from "./api";
import {normalizeMessages, parseHistory, newId} from "./history";
import type {Preferences} from "../../shared/workspace";

// The only browser-storage access: import the previous release once, then remove it.
// Never delete anything until the database confirms the transaction committed.
export async function migrateBrowserData(authenticated: boolean) {
    const keys = ["theme", "snd", "tts", "sidebar-collapsed", "sidebar-width", "thu-assistant-access-mode-v1"];
    try {
        const preferences: Partial<Preferences> = {};
        const read = (key: string) => localStorage.getItem(key);
        if (read("theme")) preferences.theme = read("theme") === "dark" ? "dark" : "light";
        if (read("snd")) preferences.sound = read("snd") === "1";
        if (read("tts")) preferences.tts = read("tts") === "1";
        if (read("sidebar-collapsed")) preferences.sidebarCollapsed = read("sidebar-collapsed") === "1";
        if (read("sidebar-width")) preferences.sidebarWidth = Math.max(220, Math.min(400, Number(read("sidebar-width")) || 264));
        if (read("thu-assistant-access-mode-v1")) preferences.accessMode = read("thu-assistant-access-mode-v1") === "full-access" ? "full-access" : "request-approval";
        let history;
        if (authenticated) {
            const saved = read("thu-assistant-sessions-v1");
            if (saved) history = parseHistory(saved);
            const legacy = read("thu-assistant-chat-v1");
            if (!history?.sessions.length && legacy) {
                const activeId = newId();
                const messages = normalizeMessages(JSON.parse(legacy), activeId);
                if (messages.length) history = {activeId, deletedSessionIds: [], sessions: [{id: activeId, title: "历史对话", createdAt: Date.now(), messages}]};
            }
        }
        if (history || Object.keys(preferences).length) await request("/api/workspace/import", {history, preferences});
        if (authenticated) keys.push("thu-assistant-sessions-v1", "thu-assistant-chat-v1");
        for (const key of keys) localStorage.removeItem(key);
    } catch (error) {
        if (error instanceof DOMException && error.name === "SecurityError") return;
        throw error;
    }
}
