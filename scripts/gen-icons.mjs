/**
 * 生成 PWA 图标（一次性工具）：清华紫圆角底 + 白色五瓣丁香几何图案。
 * 纯 Node 实现 PNG 编码（zlib 内置 + 手写 CRC），无第三方依赖、无字体渲染。
 *
 * 运行：node scripts/gen-icons.mjs
 * 产物：src/server/public/icons/icon-{192,512}.png（提交进 git，打包随 dist 带走）
 */
import {deflateSync} from "node:zlib";
import {mkdir, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src", "server", "public", "icons");

// ---- PNG 编码 ----

/** 手写 CRC-32（PNG chunk 校验用） */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBytes = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([len, typeBytes, data, crc]);
}

/** RGBA 像素 → PNG Buffer（真彩色 + alpha） */
function encodePng(width, height, rgba) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    // 每行前加 filter 字节 0（None）
    const raw = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    return Buffer.concat([
        signature,
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw, {level: 9})),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

// ---- 绘制：紫色方底 + 白色五瓣丁香（各平台 mask 会自动裁圆角，故画满幅）----

const PURPLE = [0x82, 0x31, 0x8e]; // 清华紫 #82318E
const WHITE = [0xff, 0xff, 0xff];

function renderIcon(size) {
    const rgba = Buffer.alloc(size * size * 4);
    const soft = Math.max(1, size * 0.008); // 边缘软化宽度（简易抗锯齿）
    const center = size / 2;
    const coreR = size * 0.115; // 花芯半径
    const petalR = size * 0.105; // 花瓣半径
    const petalDist = size * 0.20; // 花瓣中心到花芯中心
    const distCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
    // 距离场 → 覆盖度：形状内 1、外 0、边缘线性过渡
    const coverage = (dist) => Math.min(1, Math.max(0, 0.5 - dist / soft));

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            // 花 = 花芯 + 五个花瓣圆（顶部一片，其余每 72° 一片）的并集
            let flower = coverage(distCircle(px, py, center, center, coreR));
            for (let i = 0; i < 5; i++) {
                const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
                flower = Math.max(flower, coverage(
                    distCircle(px, py, center + petalDist * Math.cos(angle), center + petalDist * Math.sin(angle), petalR),
                ));
            }
            const base = (y * size + x) * 4;
            rgba[base] = Math.round(PURPLE[0] + (WHITE[0] - PURPLE[0]) * flower);
            rgba[base + 1] = Math.round(PURPLE[1] + (WHITE[1] - PURPLE[1]) * flower);
            rgba[base + 2] = Math.round(PURPLE[2] + (WHITE[2] - PURPLE[2]) * flower);
            rgba[base + 3] = 255;
        }
    }
    return encodePng(size, size, rgba);
}

await mkdir(outDir, {recursive: true});
for (const size of [192, 512]) {
    const png = renderIcon(size);
    const file = join(outDir, `icon-${size}.png`);
    await writeFile(file, png);
    console.log(`已生成 ${file}（${png.length} 字节）`);
}
