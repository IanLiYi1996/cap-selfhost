import { describe, expect, it, vi } from "vitest";

const serverEnvMock = vi.hoisted(() =>
	vi.fn<() => Record<string, string | undefined>>(() => ({})),
);

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
	buildEnv: {},
}));

import {
	isTranscriptionConfigured,
	isWhisperConfigured,
	parseWhisperResult,
	pollWhisperOutput,
	whisperOutputKey,
	whisperPollAttempts,
	whisperResultToEditResult,
} from "@/lib/whisper";

describe("whisperResultToEditResult", () => {
	it("把秒换算成毫秒", () => {
		const result = whisperResultToEditResult({
			language: "zh",
			model: "medium",
			durationSeconds: 2,
			words: [{ text: "你好", start: 1.2, end: 1.45, confidence: 0.93 }],
		});

		expect(result.words).toEqual([
			{
				text: "你好",
				start: 1200,
				end: 1450,
				confidence: 0.93,
				speaker: null,
				channel: null,
			},
		]);
	});

	it("毫秒取整，避免下游 clampMilliseconds 处产生小数", () => {
		const result = whisperResultToEditResult({
			language: null,
			model: "medium",
			durationSeconds: 1,
			words: [{ text: "hi", start: 0.1234, end: 0.5678, confidence: null }],
		});

		expect(result.words?.[0]?.start).toBe(123);
		expect(result.words?.[0]?.end).toBe(568);
	});

	it("channel 恒为 null；speaker 缺失时归一成 null 而不是 undefined", () => {
		const result = whisperResultToEditResult({
			language: "en",
			model: "medium",
			durationSeconds: 1,
			// 刻意不带 speaker：契约要求 string | null，undefined 会被序列化掉
			words: [{ text: "a", start: 0, end: 0.1, confidence: 0.5 }],
		});

		expect(result.words?.[0]?.speaker).toBeNull();
		expect(result.words?.[0]?.channel).toBeNull();
	});

	it("透传 diarization 给出的 speaker", () => {
		const result = whisperResultToEditResult({
			language: "zh",
			model: "medium",
			durationSeconds: 2,
			words: [
				{ text: "我是", start: 0, end: 0.4, confidence: 0.9, speaker: "A" },
				{ text: "对啊", start: 0.4, end: 0.8, confidence: 0.9, speaker: "B" },
			],
		});

		expect(result.words?.map((w) => w.speaker)).toEqual(["A", "B"]);
	});

	it("透传 language_code 与 speech_model_used", () => {
		const result = whisperResultToEditResult({
			language: "zh",
			model: "medium",
			durationSeconds: 1,
			words: [],
		});

		expect(result.language_code).toBe("zh");
		expect(result.speech_model_used).toBe("whisper-medium");
	});

	it("空词表不报错", () => {
		expect(
			whisperResultToEditResult({
				language: null,
				model: "medium",
				durationSeconds: 0,
				words: [],
			}).words,
		).toEqual([]);
	});
});

describe("parseWhisperResult", () => {
	it("接受服务产出的形状", () => {
		const parsed = parseWhisperResult({
			language: "zh",
			model: "medium",
			durationSeconds: 12.5,
			words: [{ text: "hi", start: 0, end: 0.2, confidence: 0.9 }],
		});

		expect(parsed.words).toHaveLength(1);
		expect(parsed.durationSeconds).toBe(12.5);
	});

	it("丢弃时间戳非法的词而不是整体失败", () => {
		const parsed = parseWhisperResult({
			language: "zh",
			model: "medium",
			durationSeconds: 1,
			words: [
				{ text: "ok", start: 0, end: 0.2, confidence: 0.9 },
				{ text: "bad", start: "x", end: null, confidence: 0.9 },
			],
		});

		expect(parsed.words).toHaveLength(1);
		expect(parsed.words[0]?.text).toBe("ok");
	});

	it("形状完全不对时抛错", () => {
		expect(() => parseWhisperResult({ nope: true })).toThrow();
	});
});

describe("isWhisperConfigured", () => {
	it("四个变量齐全才算配置好", () => {
		serverEnvMock.mockReturnValue({
			WHISPER_CLUSTER_ARN: "arn:cluster",
			WHISPER_TASK_DEFINITION_ARN: "arn:taskdef",
			WHISPER_SUBNET_IDS: "subnet-1,subnet-2",
			WHISPER_SECURITY_GROUP_ID: "sg-1",
		});
		expect(isWhisperConfigured()).toBe(true);
	});

	it("缺一个就算未配置", () => {
		serverEnvMock.mockReturnValue({
			WHISPER_CLUSTER_ARN: "arn:cluster",
			WHISPER_TASK_DEFINITION_ARN: "arn:taskdef",
			WHISPER_SUBNET_IDS: "subnet-1",
		});
		expect(isWhisperConfigured()).toBe(false);
	});
});

describe("isTranscriptionConfigured", () => {
	it("returns true when Whisper is configured and no AssemblyAI key is set", () => {
		serverEnvMock.mockReturnValue({
			WHISPER_CLUSTER_ARN: "arn:cluster",
			WHISPER_TASK_DEFINITION_ARN: "arn:taskdef",
			WHISPER_SUBNET_IDS: "subnet-1",
			WHISPER_SECURITY_GROUP_ID: "sg-1",
		});
		expect(isTranscriptionConfigured()).toBe(true);
	});

	it("returns true when AssemblyAI key is set and Whisper is not configured", () => {
		serverEnvMock.mockReturnValue({
			ASSEMBLY_API_KEY: "asm-key",
		});
		expect(isTranscriptionConfigured()).toBe(true);
	});

	it("returns false when neither Whisper nor AssemblyAI is configured", () => {
		serverEnvMock.mockReturnValue({});
		expect(isTranscriptionConfigured()).toBe(false);
	});
});

describe("whisperOutputKey", () => {
	it("与音频对象同前缀，便于生命周期清理", () => {
		expect(whisperOutputKey("user-1", "video-1")).toBe(
			"user-1/video-1/whisper.words.v2.json",
		);
	});
});

describe("pollWhisperOutput", () => {
	const noSleep = async () => {};

	it("对象一出现就解析并返回", async () => {
		const payload = JSON.stringify({
			language: "zh",
			model: "medium",
			durationSeconds: 1,
			words: [{ text: "hi", start: 0, end: 0.2, confidence: 0.9 }],
		});
		let calls = 0;
		const readOutput = async () => {
			calls += 1;
			return calls < 3 ? null : payload;
		};

		const result = await pollWhisperOutput(readOutput, {
			attempts: 10,
			intervalMs: 0,
			sleep: noSleep,
		});

		expect(result.words).toHaveLength(1);
		expect(calls).toBe(3);
	});

	it("超过尝试次数仍无结果则抛错", async () => {
		await expect(
			pollWhisperOutput(async () => null, {
				attempts: 3,
				intervalMs: 0,
				sleep: noSleep,
			}),
		).rejects.toThrow(/did not produce/i);
	});

	it("超时后不多睡一次：sleep 调用次数恰好是 attempts - 1", async () => {
		let sleepCalls = 0;
		const countingSleep = async () => {
			sleepCalls += 1;
		};

		await expect(
			pollWhisperOutput(async () => null, {
				attempts: 4,
				intervalMs: 0,
				sleep: countingSleep,
			}),
		).rejects.toThrow(/did not produce/i);

		expect(sleepCalls).toBe(3);
	});

	it("读取抛错时继续重试而不是立刻放弃", async () => {
		let calls = 0;
		const readOutput = async () => {
			calls += 1;
			if (calls === 1) throw new Error("transient s3 error");
			return JSON.stringify({
				language: null,
				model: "medium",
				durationSeconds: 0,
				words: [],
			});
		};

		const result = await pollWhisperOutput(readOutput, {
			attempts: 5,
			intervalMs: 0,
			sleep: noSleep,
		});

		expect(result.words).toEqual([]);
		expect(calls).toBe(2);
	});
});

describe("whisperOutputKey versioning", () => {
	// The version is what makes the workflow's skip-if-present reuse safe: an
	// artifact from an older pipeline sits under an older key and is never found,
	// rather than being reused and reintroducing the behaviour just fixed.
	it("carries a pipeline version so stale artifacts cannot be reused", () => {
		expect(whisperOutputKey("u", "v")).toMatch(/whisper\.words\.v\d+\.json$/);
	});

	it("keeps the key under the video's own prefix", () => {
		expect(whisperOutputKey("user-1", "video-1")).toMatch(/^user-1\/video-1\//);
	});
});

describe("whisperPollAttempts", () => {
	const MINUTE_MS = 60_000;
	const budgetMinutes = (attempts: number) => (attempts * 5000) / MINUTE_MS;

	it("waits at least two hours even for a short clip", () => {
		// 预算给得慷慨是刻意的：等超了只是多几次 S3 查询，等不够是把一份
		// 已经跑成功的转写直接丢掉。
		expect(budgetMinutes(whisperPollAttempts(0))).toBe(120);
		expect(budgetMinutes(whisperPollAttempts(30 * 1000))).toBe(120);
	});

	// 真实事故：31 分钟的录制在 10 分钟固定预算下必然失败，
	// 而它等待的那个 whisper 任务其实跑成功了。
	it("outlasts the 31-minute recording that exposed the old cap", () => {
		const attempts = whisperPollAttempts(1879.56 * 1000);

		// 实测需要约 40 分钟（~1.15x 实时 + 冷启动 + diarization）
		expect(budgetMinutes(attempts)).toBeGreaterThan(40);
		expect(budgetMinutes(attempts)).toBeCloseTo(125.33, 1);
	});

	it("scales past the floor for long recordings", () => {
		// 4x：medium 实测约 1.25x 实时，留给 large-v3（约 3x）也够
		expect(budgetMinutes(whisperPollAttempts(60 * MINUTE_MS))).toBe(240);
		expect(budgetMinutes(whisperPollAttempts(120 * MINUTE_MS))).toBe(480);
	});

	it("leaves headroom for large-v3 at roughly 3x realtime", () => {
		const durationMinutes = 45;
		const attempts = whisperPollAttempts(durationMinutes * MINUTE_MS);

		expect(budgetMinutes(attempts)).toBeGreaterThan(durationMinutes * 3);
	});

	it("does not let a negative duration shrink the budget", () => {
		expect(budgetMinutes(whisperPollAttempts(-1000))).toBe(120);
	});

	it("honours a custom interval", () => {
		expect(whisperPollAttempts(120 * MINUTE_MS, 10_000)).toBe(2880);
	});
});
