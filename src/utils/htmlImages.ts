/**
 * HTML 内嵌图片提取：网络学堂的公告/作业描述是富文本 HTML，
 * 老师经常把图片（课表截图、分组名单、二维码）直接贴在正文里而不是放附件。
 * htmlToText 会把 <img> 标签一并剥掉，模型连「这里有张图」都不知道。
 *
 * 这里在剥标签之前先把 <img> 换成 [图片N] 占位符并收集 src：
 *   - 模型从纯文本里能看到「[图片1]」，知道有图、是第几张
 *   - images 数组给出第 N 张对应的绝对 URL（相对路径用 baseUrl 解析，
 *     学堂正文里的图常见于 /upload/... 相对路径）
 *   - data: URI 是内联 base64（多为小图标），无法按 URL 下载，直接丢弃
 * 拿到 URL 后用带登录态的下载会话取字节，即可走 TempImageStore 在对话里显示。
 */
import {htmlToText} from "./htmlToText";

export interface InlineImage {
    /** 1 起始，与正文里的 [图片N] 占位符对应 */
    index: number;
    url: string;
}

const IMG_TAG = /<img\b[^>]*>/gi;
/** src 属性三种写法：双引号 / 单引号 / 无引号 */
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * 提取 HTML 正文中的内嵌图片。
 * 返回剥好标签的纯文本（图片位置留 [图片N] 占位）与图片清单（按出现顺序）。
 */
export function extractInlineImages(
    html: string | undefined | null,
    baseUrl: string,
): {text: string; images: InlineImage[]} {
    if (!html) return {text: "", images: []};
    const images: InlineImage[] = [];
    const withPlaceholders = html.replace(IMG_TAG, (tag) => {
        const m = SRC_ATTR.exec(tag);
        const src = m?.[1] ?? m?.[2] ?? m?.[3];
        if (!src || src.startsWith("data:")) return "";
        let url: string;
        try {
            url = new URL(src, baseUrl).toString();
        } catch {
            return ""; // 非法 URL，帮不到用户，丢弃
        }
        images.push({index: images.length + 1, url});
        return `[图片${images.length}]`;
    });
    return {text: htmlToText(withPlaceholders), images};
}
