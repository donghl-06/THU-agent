import type {StreamEvent} from "./api";
import type {Turn, TurnItem} from "./types";

// Array position is the creation order. Tool completions update their original
// entry, so concurrent calls cannot reorder the surrounding prose/reasoning.
function closeText(items: TurnItem[]): TurnItem[] {
    return items.map(item => item.kind !== "tool" && item.status === "streaming" ? {...item, status: "done"} : item);
}

export function finishTurn(turn: Turn, status: Exclude<Turn["status"], "running">, now = Date.now()): Turn {
    return {...turn, status, finishedAt: now, items: closeText(turn.items).map(item =>
        item.kind === "tool" && item.status === "running" ? {...item, status: "interrupted"} : item)};
}

export function applyTurnEvent(turn: Turn, {event, data}: StreamEvent): Turn {
    if (turn.status !== "running") return turn;
    const id = `${turn.messageId}:${turn.items.length}`;
    if (event === "token" || event === "reasoning") {
        const text = typeof data.text === "string" ? data.text : "";
        if (!text) return turn;
        const kind = event === "token" ? "text" : "reasoning";
        const last = turn.items.at(-1);
        const items: TurnItem[] = last?.kind === kind && last.status === "streaming"
            ? [...turn.items.slice(0, -1), {...last, text: last.text + text}]
            : [...closeText(turn.items), {id, kind, text, status: "streaming"}];
        return {...turn, phase: kind === "text" ? "generating" : "thinking", items};
    }
    if (event === "tool") {
        const name = String(data.name ?? "");
        const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
        let items = closeText(turn.items);
        if (data.phase === "start") {
            items = [...items, {id, kind: "tool", toolCallId, name, status: "running"}];
        } else if (data.phase === "end") {
            const index = items.findIndex(item => item.kind === "tool" && item.status === "running" &&
                (toolCallId ? item.toolCallId === toolCallId : item.name === name));
            items = items.map((item, i) => i === index && item.kind === "tool" ? {...item,
                status: data.success === false ? "error" : "done",
                ms: typeof data.ms === "number" ? data.ms : undefined,
            } : item);
        }
        return {...turn, phase: items.some(item => item.kind === "tool" && item.status === "running") ? "tool" : "thinking", items};
    }
    if (event === "confirm") return {...turn, phase: "confirm", items: closeText(turn.items)};
    if (event === "answer") {
        const text = typeof data.text === "string" ? data.text : "";
        const items = closeText(turn.items);
        const last = items.at(-1);
        // The authoritative final snapshot replaces its streamed tail, while
        // earlier text between tool batches stays inside the process fold.
        if (!text.trim()) return {...turn, items};
        const finalItemId = last?.kind === "text" ? last.id : id;
        const answer: TurnItem = {id: finalItemId, kind: "text", text, status: "done"};
        return {...turn, phase: "generating", finalItemId,
            items: last?.kind === "text" ? [...items.slice(0, -1), answer] : [...items, answer]};
    }
    if (event === "done") return finishTurn(turn, "completed");
    if (event === "error") return finishTurn(turn, "error");
    return turn;
}

export function turnText(turn: Turn): string {
    const final = turn.items.find(item => item.id === turn.finalItemId);
    if (final?.kind === "text") return final.text;
    return turn.items.flatMap(item => item.kind === "text" ? [item.text] : []).join("\n\n");
}
