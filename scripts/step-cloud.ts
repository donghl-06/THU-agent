/** 清华云盘真链验证：登录、列资料库，可选按关键词搜索。 */
import "dotenv/config";
import {CloudClient} from "../src/client/cloud/CloudClient";
import {normalizeError} from "../src/client/errors";

async function main(): Promise<void> {
    const keyword = process.argv[2]?.trim();
    const client = new CloudClient();
    console.log("正在通过清华统一身份认证登录云盘……");
    await client.login();

    const libraries = await client.listLibraries();
    console.log(`\n资料库（${libraries.length} 个）：`);
    for (const item of libraries) {
        console.log(`- ${item.name}（id=${item.id}）`);
    }

    if (keyword) {
        const results = await client.searchFiles(keyword);
        console.log(`\n搜索「${keyword}」（${results.length} 条）：`);
        for (const item of results.slice(0, 20)) {
            console.log(`- ${item.repoName}${item.path}`);
        }
    }
}

void main().catch((error) => {
    const normalized = normalizeError(error);
    console.error(`\n清华云盘验证失败：${normalized.message}`);
    process.exitCode = 1;
});
