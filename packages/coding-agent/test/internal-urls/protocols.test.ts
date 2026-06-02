import { describe, expect, it } from "bun:test";
import { fromAny } from "@total-typescript/shoehorn";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AsyncJob, AsyncJobManager } from "../../src/async";
import type { Rule } from "../../src/capability/rule";
import type { Skill } from "../../src/extensibility/skills";
import {
	AgentProtocolHandler,
	ArtifactProtocolHandler,
	InternalUrlRouter,
	JobsProtocolHandler,
	PiProtocolHandler,
	RuleProtocolHandler,
	SkillProtocolHandler,
	applyQuery,
	parseInternalUrl,
	parseQuery,
	pathToQuery,
	validateRelativePath,
} from "../../src/internal-urls";
import { EMBEDDED_DOC_FILENAMES } from "../../src/internal-urls/docs-index.generated";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function createRouter(...handlers: Array<Parameters<InternalUrlRouter["register"]>[0]>): InternalUrlRouter {
	const router = new InternalUrlRouter();
	for (const handler of handlers) router.register(handler);
	return router;
}

function makeJob(job: Omit<AsyncJob, "abortController" | "promise">): AsyncJob {
	return {
		...job,
		abortController: new AbortController(),
		promise: Promise.resolve(),
	};
}

function makeJobManager(jobs: AsyncJob[]): AsyncJobManager {
	return fromAny<AsyncJobManager>({
		getAllJobs: () => jobs,
		getJob: (id: string) => jobs.find(job => job.id === id),
	});
}

describe("json query helpers", () => {
	it("parses dotted, indexed, quoted, and escaped query tokens", () => {
		expect(parseQuery("")).toEqual([]);
		expect(parseQuery(".")).toEqual([]);
		expect(parseQuery(' .foo.bar[0][\'dash-key\']["quote\\"key"] ')).toEqual([
			"foo",
			"bar",
			0,
			"dash-key",
			'quote"key',
		]);
		expect(parseQuery(".items[slug-value]")).toEqual(["items", "slug-value"]);
	});

	it("rejects malformed query syntax before extraction", () => {
		expect(() => parseQuery(".items[0")).toThrow("missing ]");
		expect(() => parseQuery(".items[]")).toThrow("empty []");
		expect(() => parseQuery(".items/#")).toThrow("unexpected token");
	});

	it("applies parsed tokens through objects and arrays without throwing on misses", () => {
		const data = {
			foo: {
				bar: [{ value: 42 }],
				"dash-key": "ok",
			},
		};

		expect(applyQuery(data, ".foo.bar[0].value")).toBe(42);
		expect(applyQuery(data, ".foo['dash-key']")).toBe("ok");
		expect(applyQuery(data, ".foo.bar[2].value")).toBeUndefined();
		expect(applyQuery(data, ".foo.bar.value")).toBeUndefined();
		expect(applyQuery(null, ".foo")).toBeUndefined();
		expect(applyQuery("text", ".length")).toBeUndefined();
	});

	it("converts internal URL paths into equivalent query expressions", () => {
		expect(pathToQuery("")).toBe("");
		expect(pathToQuery("/")).toBe("");
		expect(pathToQuery("/foo/bar/0/")).toBe(".foo.bar[0]");
		expect(pathToQuery("/space%20key/child")).toBe("['space key'].child");
		expect(pathToQuery("/bad%zz/key")).toBe("['bad%zz'].key");
		expect(pathToQuery("/quote%27key/back%5Cslash")).toBe("['quote\\'key']['back\\\\slash']");
	});
});

describe("parseInternalUrl", () => {
	it("preserves raw host and pathname for ordinary internal URLs", () => {
		const parsed = parseInternalUrl("agent://reviewer_0/path/to/value?q=.ok#frag");

		expect(parsed.protocol).toBe("agent:");
		expect(parsed.rawHost).toBe("reviewer_0");
		expect(parsed.rawPathname).toBe("/path/to/value");
		expect(parsed.searchParams.get("q")).toBe(".ok");
		expect(parsed.hash).toBe("#frag");
	});

	it("parses namespaced hosts that the platform URL parser treats as invalid ports", () => {
		const parsed = parseInternalUrl("skill://plugin:name/docs/SKILL.md?q=1#section");

		expect(parsed.protocol).toBe("skill:");
		expect(parsed.hostname).toBe("plugin:name");
		expect(parsed.rawHost).toBe("plugin:name");
		expect(parsed.pathname).toBe("/docs/SKILL.md");
		expect(parsed.rawPathname).toBe("/docs/SKILL.md");
		expect(parsed.searchParams.get("q")).toBe("1");
		expect(parsed.hash).toBe("#section");
	});

	it("throws for inputs without an internal URL scheme", () => {
		expect(() => parseInternalUrl("not-a-url")).toThrow("Invalid URL: not-a-url");
	});

	it("leaves malformed percent escapes in the raw host instead of losing the URL", () => {
		const parsed = parseInternalUrl("skill://bad%zz/path");

		expect(parsed.rawHost).toBe("bad%zz");
		expect(parsed.rawPathname).toBe("/path");
	});
});

describe("JobsProtocolHandler", () => {
	it("renders a disabled message when no async job manager is available", async () => {
		const router = createRouter(new JobsProtocolHandler({ getAsyncJobManager: () => undefined }));
		const resource = await router.resolve("jobs://");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("Background job support is disabled");
	});

	it("lists no jobs when the manager has no retained work", async () => {
		const router = createRouter(new JobsProtocolHandler({ getAsyncJobManager: () => makeJobManager([]) }));
		const resource = await router.resolve("jobs://");

		expect(resource.content).toBe("# Jobs\n\nNo background jobs found.");
	});

	it("orders running jobs oldest first and completed jobs newest first", async () => {
		const jobs = [
			makeJob({
				id: "done-old",
				type: "bash",
				status: "completed",
				startTime: Date.parse("2026-05-14T12:00:01.000Z"),
				label: "done old",
			}),
			makeJob({
				id: "run-new",
				type: "task",
				status: "running",
				startTime: Date.parse("2026-05-14T12:00:03.000Z"),
				label: "run new",
			}),
			makeJob({
				id: "done-new",
				type: "bash",
				status: "failed",
				startTime: Date.parse("2026-05-14T12:00:04.000Z"),
				label: "done new",
			}),
			makeJob({
				id: "run-old",
				type: "bash",
				status: "running",
				startTime: Date.parse("2026-05-14T12:00:00.000Z"),
				label: "run old",
			}),
		];
		const router = createRouter(new JobsProtocolHandler({ getAsyncJobManager: () => makeJobManager(jobs) }));
		const resource = await router.resolve("jobs://");

		expect(resource.content).toContain("4 jobs");
		expect(resource.content.indexOf("`run-old`")).toBeLessThan(resource.content.indexOf("`run-new`"));
		expect(resource.content.indexOf("`run-new`")).toBeLessThan(resource.content.indexOf("`done-new`"));
		expect(resource.content.indexOf("`done-new`")).toBeLessThan(resource.content.indexOf("`done-old`"));
		expect(resource.content).toContain("started: 2026-05-14T12:00:00.000Z");
	});

	it("renders completed, failed, cancelled, and missing job detail pages", async () => {
		const jobs = [
			makeJob({
				id: "complete",
				type: "bash",
				status: "completed",
				startTime: 10,
				label: "completed job",
				resultText: "done text",
			}),
			makeJob({
				id: "fail",
				type: "task",
				status: "failed",
				startTime: 20,
				label: "failed job",
				errorText: "failure text",
			}),
			makeJob({
				id: "cancel",
				type: "bash",
				status: "cancelled",
				startTime: 30,
				label: "cancelled job",
				errorText: "cancel text",
			}),
		];
		const router = createRouter(new JobsProtocolHandler({ getAsyncJobManager: () => makeJobManager(jobs) }));

		expect((await router.resolve("jobs://complete")).content).toContain("## Result\n\n```\ndone text\n```");
		expect((await router.resolve("jobs://fail")).content).toContain("## Error\n\n```\nfailure text\n```");
		expect((await router.resolve("jobs://cancel")).content).toContain("## Cancellation\n\n```\ncancel text\n```");
		expect((await router.resolve("jobs://missing")).content).toContain("404: No async job found with id `missing`.");
	});

	it("combines host and path segments into slash-delimited job ids", async () => {
		const jobs = [
			makeJob({
				id: "batch/child",
				type: "task",
				status: "completed",
				startTime: 10,
				label: "nested",
				resultText: "nested result",
			}),
		];
		const router = createRouter(new JobsProtocolHandler({ getAsyncJobManager: () => makeJobManager(jobs) }));
		const resource = await router.resolve("jobs://batch/child");

		expect(resource.content).toContain("# Job batch/child");
	});
});

describe("AgentProtocolHandler", () => {
	it("requires a live artifacts directory and an output id", async () => {
		const noSession = createRouter(new AgentProtocolHandler({ getArtifactsDir: () => null }));
		await expect(noSession.resolve("agent://reviewer")).rejects.toThrow("No session");

		await withTempDir("agent-protocol-", async tempDir => {
			const missingDir = createRouter(
				new AgentProtocolHandler({ getArtifactsDir: () => path.join(tempDir, "missing") }),
			);
			await expect(missingDir.resolve("agent://reviewer")).rejects.toThrow("No artifacts directory found");

			const router = createRouter(new AgentProtocolHandler({ getArtifactsDir: () => tempDir }));
			await expect(router.resolve("agent://")).rejects.toThrow("agent:// URL requires an output ID");
		});
	});

	it("reads markdown outputs and reports available ids for misses", async () => {
		await withTempDir("agent-protocol-", async artifactsDir => {
			await Bun.write(path.join(artifactsDir, "reviewer_0.md"), "review text");
			const router = createRouter(new AgentProtocolHandler({ getArtifactsDir: () => artifactsDir }));

			const resource = await router.resolve("agent://reviewer_0");
			expect(resource.content).toBe("review text");
			expect(resource.contentType).toBe("text/markdown");

			await expect(router.resolve("agent://missing")).rejects.toThrow("Available: reviewer_0");
		});
	});

	it("extracts JSON with either path or query syntax and records the extraction note", async () => {
		await withTempDir("agent-protocol-", async artifactsDir => {
			await Bun.write(
				path.join(artifactsDir, "analysis.md"),
				JSON.stringify({ summary: { verdict: "pass" }, items: [{ id: 1 }] }),
			);
			const router = createRouter(new AgentProtocolHandler({ getArtifactsDir: () => artifactsDir }));

			const byPath = await router.resolve("agent://analysis/summary/verdict");
			expect(byPath.content).toBe('"pass"');
			expect(byPath.contentType).toBe("application/json");
			expect(byPath.notes).toEqual(["Extracted: .summary.verdict"]);

			const byQuery = await router.resolve("agent://analysis?q=.items[0].id");
			expect(byQuery.content).toBe("1");
			expect(byQuery.notes).toEqual(["Extracted: .items[0].id"]);
		});
	});

	it("rejects ambiguous extraction methods and non-json extraction targets", async () => {
		await withTempDir("agent-protocol-", async artifactsDir => {
			await Bun.write(path.join(artifactsDir, "text.md"), "not json");
			const router = createRouter(new AgentProtocolHandler({ getArtifactsDir: () => artifactsDir }));

			await expect(router.resolve("agent://text/value?q=.value")).rejects.toThrow("cannot combine path extraction");
			await expect(router.resolve("agent://text/value")).rejects.toThrow("is not valid JSON");
		});
	});
});

describe("ArtifactProtocolHandler", () => {
	it("requires a live artifacts directory and numeric artifact id", async () => {
		const noSession = createRouter(new ArtifactProtocolHandler({ getArtifactsDir: () => null }));
		await expect(noSession.resolve("artifact://0")).rejects.toThrow("No session");

		await withTempDir("artifact-protocol-", async tempDir => {
			const router = createRouter(new ArtifactProtocolHandler({ getArtifactsDir: () => tempDir }));

			await expect(router.resolve("artifact://")).rejects.toThrow("artifact:// URL requires a numeric ID");
			await expect(router.resolve("artifact://abc")).rejects.toThrow("artifact:// ID must be numeric");
		});
	});

	it("reads matching artifact files and lists numeric ids for misses", async () => {
		await withTempDir("artifact-protocol-", async artifactsDir => {
			await Bun.write(path.join(artifactsDir, "10.bash.log"), "ten");
			await Bun.write(path.join(artifactsDir, "2.tool.txt"), "two");
			await Bun.write(path.join(artifactsDir, "note.txt"), "ignored");
			const router = createRouter(new ArtifactProtocolHandler({ getArtifactsDir: () => artifactsDir }));

			const resource = await router.resolve("artifact://2");
			expect(resource.content).toBe("two");
			expect(resource.contentType).toBe("text/plain");
			expect(resource.sourcePath).toBe(path.join(artifactsDir, "2.tool.txt"));

			await expect(router.resolve("artifact://3")).rejects.toThrow("Available: 2, 10");
		});
	});

	it("reports a missing artifacts directory before matching ids", async () => {
		await withTempDir("artifact-protocol-", async tempDir => {
			const router = createRouter(
				new ArtifactProtocolHandler({
					getArtifactsDir: () => path.join(tempDir, "missing"),
				}),
			);

			await expect(router.resolve("artifact://1")).rejects.toThrow("No artifacts directory found");
		});
	});
});

describe("InternalUrlRouter", () => {
	it("checks registered schemes without parsing and reports supported protocols for misses", async () => {
		const router = createRouter(new PiProtocolHandler());

		expect(router.canHandle("pi://models.md")).toBe(true);
		expect(router.canHandle("PI://models.md")).toBe(true);
		expect(router.canHandle("agent://reviewer")).toBe(false);
		expect(router.canHandle("not-a-url")).toBe(false);
		await expect(router.resolve("agent://reviewer")).rejects.toThrow("Supported: pi://");
	});
});

describe("RuleProtocolHandler", () => {
	const rule: Rule = {
		name: "repo-style",
		path: "/rules/repo-style.md",
		content: "Use repo style.",
		_source: {
			provider: "test",
			providerName: "Test",
			path: "/rules/repo-style.md",
			level: "project",
		},
	};

	it("resolves known rules and reports unknown names with the available set", async () => {
		const router = createRouter(new RuleProtocolHandler({ getRules: () => [rule] }));

		const resource = await router.resolve("rule://repo-style");
		expect(resource.content).toBe("Use repo style.");
		expect(resource.contentType).toBe("text/markdown");
		expect(resource.sourcePath).toBe("/rules/repo-style.md");

		await expect(router.resolve("rule://missing")).rejects.toThrow("Available: repo-style");
		await expect(router.resolve("rule://")).rejects.toThrow("rule:// URL requires a rule name");
	});
});

describe("SkillProtocolHandler", () => {
	it("validates skill-relative paths before filesystem access", () => {
		expect(() => validateRelativePath("docs/reference.md")).not.toThrow();
		expect(() => validateRelativePath("/absolute.md")).toThrow("Absolute paths are not allowed");
		expect(() => validateRelativePath("../secret.md")).toThrow("Path traversal");
		expect(() => validateRelativePath("docs/../../secret.md")).toThrow("Path traversal");
	});

	it("reads SKILL.md and relative files while keeping paths inside the skill base directory", async () => {
		await withTempDir("skill-protocol-", async tempDir => {
			const baseDir = path.join(tempDir, "demo");
			const skillPath = path.join(baseDir, "SKILL.md");
			await fs.mkdir(path.join(baseDir, "docs"), { recursive: true });
			await Bun.write(skillPath, "# Demo skill");
			await Bun.write(path.join(baseDir, "docs", "guide.txt"), "guide text");
			const skill: Skill = {
				name: "demo",
				description: "demo skill",
				filePath: skillPath,
				baseDir,
				source: "test:user",
			};
			const router = createRouter(new SkillProtocolHandler({ getSkills: () => [skill] }));

			const skillDoc = await router.resolve("skill://demo");
			expect(skillDoc.content).toBe("# Demo skill");
			expect(skillDoc.contentType).toBe("text/markdown");

			const guide = await router.resolve("skill://demo/docs/guide.txt");
			expect(guide.content).toBe("guide text");
			expect(guide.contentType).toBe("text/plain");

			await expect(router.resolve("skill://missing")).rejects.toThrow("Available: demo");
			await expect(router.resolve("skill://demo/missing.txt")).rejects.toThrow("File not found:");
		});
	});
});

describe("PiProtocolHandler", () => {
	it("lists bundled docs and reads a known embedded file", async () => {
		const router = createRouter(new PiProtocolHandler());
		const firstDoc = EMBEDDED_DOC_FILENAMES[0];

		const listing = await router.resolve("pi://");
		expect(listing.content).toContain("# Documentation");
		expect(listing.content).toContain(`pi://${firstDoc}`);

		const doc = await router.resolve(`pi://${firstDoc}`);
		expect(doc.contentType).toBe("text/markdown");
		expect(doc.content.length).toBeGreaterThan(0);
	});

	it("rejects unsafe or unknown documentation paths with user-facing guidance", async () => {
		const router = createRouter(new PiProtocolHandler());

		await expect(router.resolve("pi://%2Fabsolute.md")).rejects.toThrow("Absolute paths are not allowed");
		await expect(router.resolve("pi://..%2Fsecret.md")).rejects.toThrow("Path traversal");
		await expect(router.resolve("pi://missing-doc.md")).rejects.toThrow("Use pi:// to list available files");
	});
});
