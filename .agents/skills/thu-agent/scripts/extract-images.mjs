#!/usr/bin/env node
/** Consume a SkillResult on stdin and save its images in a private temporary directory. */
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

function imageType(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
    if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "jpeg";
    if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "gif";
    if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
    throw new Error("unsupported image");
}

async function main() {
    let raw = "";
    for await (const chunk of process.stdin) {
        raw += chunk;
        if (raw.length > 32_000_000) throw new Error("input too large");
    }
    const result = JSON.parse(raw);
    if (result?.success === false) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = 1;
        return;
    }
    const images = result?.data?.imagesBase64;
    if (result?.success !== true || !Array.isArray(images) || images.length < 1 || images.length > 4) {
        throw new Error("missing images");
    }
    // Validate every image before writing anything. Never accept names or paths from upstream.
    const decoded = images.map((image) => {
        if (typeof image !== "string" || image.length > 6_000_000) throw new Error("image too large");
        const base64 = image.replace(/^data:image\/(?:png|jpe?g|webp|gif);base64,/, "");
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("invalid base64");
        const bytes = Buffer.from(base64, "base64");
        if (bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) throw new Error("invalid base64");
        return {bytes, type: imageType(bytes)};
    });
    const directory = mkdtempSync(join(tmpdir(), "thu-agent-images-"));
    const files = decoded.map(({bytes, type}, index) => {
        const path = join(directory, `image-${index + 1}.${type}`);
        writeFileSync(path, bytes, {flag: "wx", mode: 0o600});
        return {path, mimeType: `image/${type}`};
    });
    process.stdout.write(`${JSON.stringify({success: true, data: {note: result.data.note, images: files}})}\n`);
}

void main().catch(() => {
    process.stdout.write(`${JSON.stringify({success: false, error: {
        code: "IMAGE_EXTRACTION_FAILED",
        message: "Expected a successful SkillResult with 1–4 PNG, JPEG, GIF or WebP images in data.imagesBase64 (up to 6 MB base64 each).",
    }})}\n`);
    process.exitCode = 2;
});
