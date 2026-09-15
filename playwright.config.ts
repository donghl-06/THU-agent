import {defineConfig, devices} from "@playwright/test";

export default defineConfig({
    testDir: "./tests/web",
    testMatch: "**/*.spec.ts",
    fullyParallel: false,
    workers: 1,
    timeout: 25000,
    use: {baseURL: "http://127.0.0.1:3461", ...devices["Desktop Chrome"], viewport: {width: 1440, height: 960}, screenshot: "only-on-failure", trace: "retain-on-failure", serviceWorkers: "block"},
    webServer: {command: "pnpm web:build && pnpm exec tsx scripts/web-ui-fixture.ts", url: "http://127.0.0.1:3461", reuseExistingServer: false, timeout: 30000},
});
