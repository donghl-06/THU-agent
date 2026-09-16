import type {AccessMode} from "../harness/accessMode";
import type {SessionsState} from "../web/lib/types";

export interface Preferences {
    theme: "light" | "dark";
    sound: boolean;
    tts: boolean;
    sidebarCollapsed: boolean;
    sidebarWidth: number;
    accessMode: AccessMode;
}

export const defaultPreferences: Preferences = {
    theme: "light", sound: true, tts: false, sidebarCollapsed: false,
    sidebarWidth: 264, accessMode: "request-approval",
};

export interface UserProfile {username: string; name?: string; email?: string}
export interface WorkspaceData {
    history: SessionsState;
    preferences: Preferences;
    profile?: UserProfile;
    authenticated: boolean;
    revision: string;
}

export function validPreferences(value: unknown): Partial<Preferences> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preferences");
    const data = value as Record<string, unknown>;
    const result: Partial<Preferences> = {};
    for (const key of Object.keys(data)) {
        const item = data[key];
        if (key === "theme" && (item === "dark" || item === "light")) result.theme = item;
        else if ((key === "sound" || key === "tts" || key === "sidebarCollapsed") && typeof item === "boolean") result[key] = item;
        else if (key === "sidebarWidth" && typeof item === "number" && Number.isFinite(item) && item >= 220 && item <= 400) result.sidebarWidth = item;
        else if (key === "accessMode" && (item === "request-approval" || item === "full-access")) result.accessMode = item;
        else throw new Error("Invalid preference");
    }
    return result;
}
