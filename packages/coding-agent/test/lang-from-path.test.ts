import { describe, expect, it } from "bun:test";
import { detectLanguageId, getLanguageFromPath } from "../src/utils/lang-from-path";

describe("language detection from paths", () => {
	it("detects special Docker, Just, CMake, and env filenames for UI highlighting", () => {
		expect(getLanguageFromPath("src/app.ts")).toBe("typescript");
		expect(getLanguageFromPath("Dockerfile.dev")).toBe("dockerfile");
		expect(getLanguageFromPath("Containerfile")).toBe("dockerfile");
		expect(getLanguageFromPath("Justfile")).toBe("just");
		expect(getLanguageFromPath("CMakeLists.txt")).toBe("cmake");
		expect(getLanguageFromPath(".env.local")).toBe("env");
	});

	it("detects special filenames for LSP language identifiers", () => {
		expect(detectLanguageId("Dockerfile.test")).toBe("dockerfile");
		expect(detectLanguageId("Makefile")).toBe("makefile");
		expect(detectLanguageId("GNUmakefile")).toBe("makefile");
		expect(detectLanguageId("Justfile")).toBe("just");
		expect(detectLanguageId("CMakeLists.txt")).toBe("cmake");
		expect(detectLanguageId("project.cmake")).toBe("cmake");
		expect(detectLanguageId("unknown.nope")).toBe("plaintext");
	});
});
