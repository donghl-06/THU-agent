import {defineConfig} from "vitest/config";

export default defineConfig({
    test: {
        // 只跑本项目的 tests/，不要扫到 reference/ 和 node_modules 里的测试
        include: ["tests/**/*.test.ts"],
        // 集成测试要走真实登录 + 漫游，可能很慢
        testTimeout: 180_000,
        hookTimeout: 180_000,
    },
});
