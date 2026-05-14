import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// The .mts extension in the second glob is intentional: under the
		// NodeNext module resolution inherited from tsconfig, .mts files are
		// treated as ESM, matching the project's module format.
		include: ["src/**/*.test.ts", ".sandcastle/src/**/*.test.mts"],
		exclude: ["**/node_modules/**", ".sandcastle/worktrees/**"],
	},
});
