import Markdown, {type Components} from "react-markdown";
import remarkGfm from "remark-gfm";
import {useState, type ComponentProps} from "react";

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

// Stable component types preserve image deletion state when the conversation rerenders.
const components: Components = {
    a: ({node: _node, children, ...props}) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
    table: ({node: _node, children, ...props}) => <div className="table-scroll"><table {...props}>{children}</table></div>,
    img: ({node: _node, ...props}) => <InlineImage key={props.src} {...props}/>,
};

export default function MarkdownContent({text}: {text: string}) {
    return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</Markdown></div>;
}
