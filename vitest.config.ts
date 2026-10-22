import { defineConfig } from "vitest/config";

// ssh asks the developer's agent before our key file; a locked or prompting agent (e.g. a password manager's) hangs
// the connection. The tests use only the key file, so they run without an agent.
delete process.env.SSH_AUTH_SOCK;

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["test/global-setup.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
		pool: "forks",
		fileParallelism: false,
	},
});
