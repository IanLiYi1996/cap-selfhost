import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for a failure the rest of the provider tests structurally
 * cannot see.
 *
 * `@ai-sdk/amazon-bedrock` resolves credentials when a request is made, not when
 * the model is constructed. So `getAiModel("generation")?.modelId` succeeds even
 * with no credentials reachable at all, and the real failure only appears in
 * production as:
 *
 *   AWS SigV4 authentication requires AWS credentials.
 *   Original error: AWS access key ID setting is missing.
 *
 * The provider reads only AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the
 * environment; it does not walk the AWS credential chain. An ECS task role is
 * served from the container metadata endpoint instead, so the chain has to be
 * handed in explicitly. This asserts on the settings actually passed.
 */

type BedrockSettings = Record<string, unknown>;

const createAmazonBedrock = vi.hoisted(() =>
	// The settings parameter has to be declared, or the mock's args tuple infers
	// as `[]` and every `mock.calls[0][0]` becomes a type error.
	vi.fn((_settings: BedrockSettings) => (modelId: string) => ({ modelId })),
);
const fromNodeProviderChain = vi.hoisted(() => {
	const resolve = vi.fn(async () => ({
		accessKeyId: "ASIA-from-task-role",
		secretAccessKey: "secret",
		sessionToken: "token",
	}));
	return vi.fn(() => resolve);
});

vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain }));

const serverEnv = vi.hoisted(() => vi.fn());
vi.mock("@cap/env", () => ({ serverEnv }));

import { getAiModel } from "@/lib/ai/provider";

const bedrockEnv = {
	AI_PROVIDER: "bedrock",
	BEDROCK_REGION: "us-east-1",
} as unknown as ReturnType<typeof serverEnv>;

describe("bedrock credentials", () => {
	beforeEach(() => {
		createAmazonBedrock.mockClear();
		fromNodeProviderChain.mockClear();
		serverEnv.mockReturnValue(bedrockEnv);
	});

	it("hands the provider an explicit credential chain", () => {
		getAiModel("generation")?.model();

		expect(createAmazonBedrock).toHaveBeenCalledTimes(1);
		const settings = createAmazonBedrock.mock.calls[0]?.[0];
		expect(settings?.region).toBe("us-east-1");
		expect(typeof settings?.credentialProvider).toBe("function");
	});

	it("resolves credentials that the task role would supply", async () => {
		getAiModel("generation")?.model();

		const credentialProvider = createAmazonBedrock.mock.calls[0]?.[0]
			.credentialProvider as () => Promise<{ accessKeyId: string }>;

		await expect(credentialProvider()).resolves.toMatchObject({
			accessKeyId: "ASIA-from-task-role",
		});
	});

	it("never passes static keys of its own", () => {
		getAiModel("generation")?.model();

		const settings = createAmazonBedrock.mock.calls[0]?.[0];
		expect(settings?.accessKeyId).toBeUndefined();
		expect(settings?.secretAccessKey).toBeUndefined();
		expect(settings?.apiKey).toBeUndefined();
	});

	it("reuses one credential chain across models and roles", () => {
		getAiModel("generation")?.model();
		getAiModel("chat")?.model();
		getAiModel("chat-streaming")?.model();

		// Asserted as identity rather than a call count: the chain is memoised at
		// module scope, so a count would depend on which test ran first. Re-walking
		// env, SSO and container metadata per generation would be a needless round
		// trip — the chain caches and refreshes on its own.
		const providers = createAmazonBedrock.mock.calls.map(
			(call) => call[0].credentialProvider,
		);
		expect(providers).toHaveLength(3);
		expect(new Set(providers).size).toBe(1);
	});
});
