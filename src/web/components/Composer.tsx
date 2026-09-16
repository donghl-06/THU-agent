import {useEffect, useLayoutEffect, useRef, useState, type ChangeEvent} from "react";
import {AnimatePresence, motion} from "motion/react";
import {ArrowUp, Cross, FileUp, LoaderCircle, Mic, Square, X} from "lucide-react";
import type {Assistant} from "../lib/useAssistant";
import type {UploadedFile} from "../lib/types";
import {useSpeech} from "../lib/useSpeech";
import {IconButton} from "./Controls";
import {AccessModePicker} from "./AccessModePicker";

export function Composer({app, value, setValue, onSend}: {app: Assistant; value: string; setValue: (text: string) => void; onSend: (text: string, images: string[], files: UploadedFile[]) => void}) {
    interface PendingImage {
        dataUrl: string;
        file?: UploadedFile;
    }
    const [images, setImages] = useState<PendingImage[]>([]);
    const [files, setFiles] = useState<UploadedFile[]>([]);
    const [uploading, setUploading] = useState(false);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const speech = useSpeech(value, setValue, app.notify, textarea);
    const busy = Boolean(app.turn);
    const wasBusy = useRef(busy);
    const uploadGeneration = useRef(0);
    useLayoutEffect(() => {
        if (textarea.current) { textarea.current.style.height = "auto"; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 160)}px`; }
    }, [value]);
    useEffect(() => {
        if (wasBusy.current && !busy) textarea.current?.focus();
        wasBusy.current = busy;
    }, [busy]);
    useEffect(() => {
        uploadGeneration.current++;
        setImages([]);
        setFiles([]);
        setUploading(false);
        speech.stop();
    }, [app.history.activeId, app.authenticated]);
    useEffect(() => () => { uploadGeneration.current++; }, []);

    async function selectAttachments(event: ChangeEvent<HTMLInputElement>) {
        const selected = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (!app.authenticated) { app.openLogin(); return; }
        const generation = uploadGeneration.current;
        let imageCount = images.length;
        setUploading(true);
        try {
            for (const file of selected) {
                if (generation !== uploadGeneration.current) break;
                if (!file.size) { app.notify(`「${file.name}」是空文件`, "error"); continue; }
                if (app.vision && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
                    if (imageCount >= 4) { app.notify("最多一次发送 4 张图片"); continue; }
                    if (file.size > 4.5 * 1024 * 1024) { app.notify("图片超过 4.5 MB，请先压缩", "error"); continue; }
                    try {
                        const image = await new Promise<string>((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(String(reader.result));
                            reader.onerror = reject;
                            reader.readAsDataURL(file);
                        });
                        if (generation !== uploadGeneration.current) break;
                        const pendingImage = {dataUrl: image};
                        setImages(prev => [...prev, pendingImage]);
                        imageCount++;
                        // 图片同时落盘：视觉模型继续用 dataUrl，云盘上传/作业提交等工具使用真实本机路径。
                        try {
                            const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {method: "POST", body: file});
                            if (generation !== uploadGeneration.current) break;
                            if (response.status === 401) {
                                app.notify(`「${file.name}」可用于识图；请重新登录后才能作为云盘上传源`, "error");
                            } else if (!response.ok) {
                                throw new Error("upload failed");
                            } else {
                                const saved = await response.json() as UploadedFile;
                                if (generation !== uploadGeneration.current) break;
                                setImages(prev => prev.map(item => item === pendingImage ? {...item, file: {...saved, isImage: true}} : item));
                            }
                        } catch {
                            if (generation === uploadGeneration.current) {
                                app.notify(`「${file.name}」可用于识图，但暂不能作为云盘上传源`, "error");
                            }
                        }
                    } catch { if (generation === uploadGeneration.current) app.notify("无法读取图片，请重试", "error"); }
                    continue;
                }
                if (file.size > 50 * 1024 * 1024) { app.notify(`「${file.name}」超过 50 MB，请先压缩`, "error"); continue; }
                try {
                    const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {method: "POST", body: file});
                    if (generation !== uploadGeneration.current) break;
                    if (response.status === 401) { app.notify("请先登录后再上传文件", "error"); app.openLogin(); break; }
                    if (!response.ok) throw new Error("upload failed");
                    const saved = await response.json() as UploadedFile;
                    if (generation !== uploadGeneration.current) break;
                    setFiles(prev => [...prev, saved]);
                    app.notify(`已上传「${saved.name}」，发送消息后清灵即可使用`, "success");
                } catch {
                    if (generation === uploadGeneration.current) app.notify(`上传「${file.name}」失败，请重试`, "error");
                }
            }
        } finally {
            if (generation === uploadGeneration.current) setUploading(false);
        }
    }
    function send() {
        if (busy || uploading) return;
        speech.stop();
        const imageFiles = images.map(item => item.file).filter((file): file is UploadedFile => Boolean(file));
        onSend(value.trim(), images.map(item => item.dataUrl), [...files, ...imageFiles]);
        if (app.authenticated) { setImages([]); setFiles([]); }
    }
    return <div className="composer-area">
        <motion.div className={`composer ${speech.listening ? "listening" : ""}`} initial={{opacity: 0, y: 14}} animate={{opacity: 1, y: 0}} transition={{duration: .45, delay: .1}}>
            <AnimatePresence>{(images.length > 0 || files.length > 0) && <motion.div className="attachments" initial={{height: 0, opacity: 0}} animate={{height: "auto", opacity: 1}} exit={{height: 0, opacity: 0}}>
                {images.map((image, index) => <div key={image.dataUrl} className="attachment" title={image.file?.path ?? (image.dataUrl ? "仅用于视觉理解，暂无本机路径" : "正在读取图片…")}><img src={image.dataUrl} alt={`待发送图片 ${index + 1}`}/><IconButton icon={X} label={`移除图片 ${index + 1}`} onClick={() => setImages(prev => prev.filter((_, i) => i !== index))}/></div>)}
                {files.map(file => <div key={file.path} className="attachment"><span className="file-attachment"><FileUp size={19}/><span>{file.name}</span></span><IconButton icon={X} label={`移除文件 ${file.name}`} onClick={() => setFiles(prev => prev.filter(item => item.path !== file.path))}/></div>)}
            </motion.div>}</AnimatePresence>
            <textarea ref={textarea} aria-label="发送给清灵的消息" placeholder={speech.listening ? "正在聆听，点击麦克风结束…" : "发消息给清灵…"} rows={1} value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!busy && !uploading && (value.trim() || images.length || files.length)) send(); }
            }} disabled={Boolean(app.lifecycle)}/>
            <div className="composer-toolbar"><div className="composer-tools">
                <IconButton icon={uploading ? LoaderCircle : Cross} className={uploading ? "spin-icon" : ""} label="添加附件" disabled={busy || uploading || Boolean(app.lifecycle)} onClick={() => app.authenticated ? input.current?.click() : app.openLogin()}/>
                <AccessModePicker mode={app.accessMode} change={app.changeAccessMode} disabled={busy || app.loginPending || app.confirmBusy || Boolean(app.lifecycle)}/>
            </div><div className="composer-send-actions">
                <IconButton icon={Mic} label={speech.listening ? "停止语音输入" : "语音输入"} className={speech.listening ? "recording" : ""} aria-pressed={speech.listening} disabled={busy} onClick={speech.toggle}/>
                <button className={`send-button ${busy ? "stop-button" : ""}`} aria-label={app.stopping ? "正在停止" : busy ? "停止生成" : "发送消息"} title={busy ? "停止生成" : "发送消息"} disabled={app.stopping || uploading || app.loginPending || Boolean(app.lifecycle) || (!busy && !value.trim() && !images.length && !files.length)} onClick={() => busy ? app.stop() : send()}>{app.stopping ? <LoaderCircle size={19} className="spin"/> : busy ? <Square size={16} fill="currentColor"/> : <ArrowUp size={21} strokeWidth={2}/>}</button>
            </div></div>
            <input ref={input} type="file" aria-label="选择附件" multiple hidden onChange={event => void selectAttachments(event)}/>
        </motion.div>
        <p className="disclaimer">清灵的回答可能存在误差，重要信息请以学校官方信息为准</p>
    </div>;
}
