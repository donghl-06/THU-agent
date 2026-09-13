import {defineConfig} from "vitest/config";

export default defineConfig({
    test: {
        // 只跑本项目的 tests/，不要扫到 reference/ 和 node_modules 里的测试
        include: ["tests/**/*.test.ts"],
        // 集成测试要走真实登录 + 漫游，可能很慢
        testTimeout: 180_000,
        hookTimeout: 180_000,
        // webServer 系测试对并发负载时序敏感（SSE/端口/文件IO），文件间并行下偶发假失败——串行换稳定
        fileParallelism: false,
    },
});
