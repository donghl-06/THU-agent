import Markdown, {type Components} from "react-markdown";
import remarkGfm from "remark-gfm";
import {ExternalLink, FileAudio, FileText, FileVideo, TriangleAlert} from "lucide-react";
import {useEffect, useState, type ComponentProps} from "react";

function InlineImage({src, alt, ...props}: ComponentProps<"img">) {
    const [gone, setGone] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState(false);
    const temporary = typeof src === "string" && src.startsWith("/api/temp-image/");
    async function remove() {
        if (!temporary || deleting) return;
        setDeleting(true);
        setError(false);
        try {
            const response = await fetch(src, {method: "DELETE"});
            if (!response.ok && response.status !== 404) throw new Error("delete failed");
            setGone(true);
        } catch { setError(true); }
        finally { setDeleting(false); }
    }
    if (gone) return <span className="image-note">（临时图片已清理，可让清灵重新获取）</span>;
    return <span className="inline-image">
        <a href={src} target="_blank" rel="noopener noreferrer"><img {...props} src={src} alt={alt} onError={() => { if (temporary) setGone(true); }}/></a>
        {temporary && <button className="image-done" disabled={deleting} onClick={() => void remove()}>{deleting ? "正在删除…" : "已用完，删除图片"}</button>}
        {error && <span className="image-note" role="alert">删除失败，请重试</span>}
    </span>;
}

/**
 * 课件预览卡片（preview_learn_file 的产物，markdown 形如 ![file:第三章.pdf](/api/temp-image/<token>)）。
 * PDF 用 iframe 内嵌翻阅；PPT/PPTX 浏览器无法内嵌渲染，卡片给出下载入口。
 * 与 InlineImage 同一删除通道：点「已用完，删除」DELETE 临时 URL，服务端删掉落盘文件。
 */
function FilePreview({src, alt}: {src?: string; alt?: string}) {
    const name = (alt ?? "").trim().slice("file:".length).trim() || "课件文件";
    const temporary = typeof src === "string" && src.startsWith("/api/temp-image/");
    const isPdf = /\.pdf$/i.test(name);
    const [gone, setGone] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState(false);

    // iframe 没有可靠的加载失败事件：进入历史时先探一下，文件已删则直接显示兜底文案
    useEffect(() => {
        if (!temporary || typeof src !== "string") return;
        let cancelled = false;
        fetch(src, {method: "HEAD"})
            .then((r) => { if (!cancelled && r.status === 404) setGone(true); })
            .catch(() => { /* 网络抖动不当作已删除 */ });
        return () => { cancelled = true; };
    }, [src, temporary]);

    async function remove() {
        if (!temporary || deleting) return;
        setDeleting(true);
        setError(false);
        try {
            const response = await fetch(src!, {method: "DELETE"});
            if (!response.ok && response.status !== 404) throw new Error("delete failed");
            setGone(true);
        } catch { setError(true); }
        finally { setDeleting(false); }
    }

    if (gone) return <span className="image-note">（课件文件已删除，可让清灵重新获取）</span>;
    return <span className="file-preview">
        <span className="file-preview-title">
            <FileText size={15}/>
            <span title={name}>{name}</span>
        </span>
        {isPdf
            ? <iframe className="file-preview-frame" src={src} title={name}/>
            : <span className="file-preview-hint">浏览器无法直接预览 PPT，可下载后用 Office / WPS 打开。</span>}
        <span className="file-preview-actions">
            <a href={src} target="_blank" rel="noopener noreferrer">
                {isPdf ? "新窗口打开" : "下载文件"}
                <ExternalLink size={12}/>
            </a>
            {temporary && <button className="image-done" disabled={deleting} onClick={() => void remove()}>{deleting ? "正在删除…" : "已用完，删除文件"}</button>}
        </span>
        {error && <span className="image-note" role="alert">删除失败，请重试</span>}
    </span>;
}

function CloudMedia({src, alt}: {src?: string; alt?: string}) {
    const text = (alt ?? "").trim();
    const kind = text.startsWith("video:") ? "video" : text.startsWith("audio:") ? "audio" : undefined;
    const [failed, setFailed] = useState(false);
    if (!kind || typeof src !== "string") return null;

    const name = text.slice(kind.length + 1).trim() || "清华云盘文件";
    let trusted = false;
    try {
        const url = new URL(src, window.location.href);
        trusted = url.protocol === "https:" &&
            (url.hostname === "cloud.tsinghua.edu.cn" || url.hostname.endsWith(".tsinghua.edu.cn"));
    } catch { /* Invalid URLs are never rendered as media. */ }

    const Icon = kind === "video" ? FileVideo : FileAudio;
    if (!trusted) return <span className="cloud-media-warning">云盘媒体链接无效，已停止加载。</span>;

    return <span className={`cloud-media ${kind}`}>
        <span className="cloud-media-title">
            <Icon size={15}/>
            <span title={name}>{name}</span>
        </span>
        {kind === "video"
            ? <video controls preload="metadata" src={src} onError={() => setFailed(true)}/>
            : <audio controls preload="metadata" src={src} onError={() => setFailed(true)}/>}
        <span className="cloud-media-actions">
            <a href={src} target="_blank" rel="noopener noreferrer">
                {kind === "video" ? "新窗口打开 / 下载" : "下载音频"}
                <ExternalLink size={12}/>
            </a>
        </span>
        {failed && <span className="cloud-media-error" role="alert">
            <TriangleAlert size={12}/>
            云盘访问链接已过期或浏览器暂不支持该编码，可让清灵重新打开。
        </span>}
    </span>;
}

// Stable component types preserve image deletion state when the conversation rerenders.
const components: Components = {
    a: ({node: _node, children, ...props}) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
    table: ({node: _node, children, ...props}) => <div className="table-scroll"><table {...props}>{children}</table></div>,
    img: ({node: _node, ...props}) => {
        const alt = typeof props.alt === "string" ? props.alt.trim() : "";
        if (alt.startsWith("video:") || alt.startsWith("audio:")) {
            return <CloudMedia key={props.src} src={props.src} alt={props.alt}/>;
        }
        if (alt.startsWith("file:")) {
            return <FilePreview key={props.src} src={props.src} alt={props.alt}/>;
        }
        return <InlineImage key={props.src} {...props}/>;
    },
};

export default function MarkdownContent({text}: {text: string}) {
    return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</Markdown></div>;
}
