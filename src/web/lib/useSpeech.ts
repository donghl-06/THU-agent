import {useEffect, useRef, useState} from "react";

interface SpeechResult {isFinal: boolean; [index: number]: {transcript: string}}
interface SpeechRecognitionInstance {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: ((event: {results: ArrayLike<SpeechResult>}) => void) | null;
    onerror: ((event: {error: string}) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
}
type SpeechWindow = Window & {SpeechRecognition?: new () => SpeechRecognitionInstance; webkitSpeechRecognition?: new () => SpeechRecognitionInstance};

export function useSpeech(value: string, onChange: (text: string) => void, notify: (text: string) => void) {
    const [listening, setListening] = useState(false);
    const recognition = useRef<SpeechRecognitionInstance | null>(null);
    const continuing = useRef(false);
    const restartTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const changeRef = useRef(onChange);
    changeRef.current = onChange;
    const Recognition = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
    function stop() {
        continuing.current = false;
        clearTimeout(restartTimer.current);
        recognition.current?.stop();
        setListening(false);
    }
    function toggle() {
        if (continuing.current) { stop(); return; }
        if (!Recognition) { notify("当前浏览器不支持语音输入，请使用支持语音识别的浏览器并允许麦克风权限。"); return; }
        let base = value.trim() ? `${value.trim()} ` : "";
        continuing.current = true;
        setListening(true);
        function start() {
            const rec = new Recognition!();
            recognition.current = rec;
            rec.lang = "zh-CN";
            rec.continuous = true;
            rec.interimResults = true;
            let final = "";
            rec.onresult = event => {
                let interim = "";
                final = "";
                for (const result of Array.from(event.results)) {
                    if (result.isFinal) final += result[0].transcript;
                    else interim += result[0].transcript;
                }
                changeRef.current(base + final + interim);
            };
            rec.onend = () => {
                base += final;
                recognition.current = null;
                if (continuing.current) restartTimer.current = setTimeout(start, 250);
            };
            rec.onerror = event => {
                continuing.current = false;
                setListening(false);
                notify(event.error === "not-allowed" ? "请在浏览器中允许麦克风权限。" : "语音识别暂时不可用，请稍后重试。");
            };
            try { rec.start(); } catch { continuing.current = false; setListening(false); notify("无法启动语音输入，请稍后重试。"); }
        }
        start();
    }
    useEffect(() => () => {
        continuing.current = false;
        clearTimeout(restartTimer.current);
        if (recognition.current) { recognition.current.onend = null; recognition.current.abort(); }
    }, []);
    return {listening, stop, toggle};
}
