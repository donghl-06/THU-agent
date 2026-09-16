export interface UploadedFile {
    name: string;
    path: string;
    sizeBytes: number;
}

export interface Usage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costYuan?: number;
}

export interface Message {
    id: string;
    role: "user" | "bot";
    text: string;
    imageCount?: number;
    images?: string[];
    usage?: Usage;
    notification?: boolean;
    turn?: Turn;
}

export interface Session {
    id: string;
    title: string;
    createdAt: number;
    updatedAt?: number;
    titleLlm?: boolean;
    tokens?: number;
    messages: Message[];
    results?: Result[];
}

export interface SessionsState {
    activeId: string;
    sessions: Session[];
    deletedSessionIds: string[];
}

export interface ToolStep {
    id: string;
    kind: "tool";
    toolCallId?: string;
    name: string;
    status: "running" | "done" | "error" | "interrupted";
    ms?: number;
}

export interface TextStep {
    id: string;
    kind: "text" | "reasoning";
    text: string;
    status: "streaming" | "done";
}

export type TurnItem = ToolStep | TextStep;

export interface Turn {
    sessionId: string;
    messageId: string;
    startedAt: number;
    finishedAt?: number;
    status: "running" | "completed" | "cancelled" | "error";
    phase: "thinking" | "tool" | "generating" | "confirm";
    items: TurnItem[];
    finalItemId?: string;
}

export interface AuthState {
    phase: "login" | "method" | "code";
    origin: "login" | "chat";
    id?: string;
    methods?: string[];
    phone?: string;
    message: string;
    error?: boolean;
}

export type Confirmation =
    | {kind: "write"; id: string; name: string; args: Record<string, unknown>}
    | {kind: "delete"; session: Session}
    | {kind: "logout"};

export type Result =
    | {id: string; kind: "qr"; url: string; dataUrl?: string}
    | {id: string; kind: "payform"; html: string}
    | {id: string; kind: "calendar"; title: string; filename: string; icsContent: string};

export interface Notice {
    id: string;
    message: string;
    type: "info" | "success" | "error";
}
