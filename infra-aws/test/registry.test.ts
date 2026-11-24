import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

describe("Registry", () => {
	it("建三个 ECR 仓库", () => {
		template.resourceCountIs("AWS::ECR::Repository", 3);
	});

	it("推送时扫描镜像", () => {
		const repos = Object.values(template.findResources("AWS::ECR::Repository"));
		for (const repo of repos) {
			expect(repo.Properties?.ImageScanningConfiguration).toEqual({
				ScanOnPush: true,
			});
		}
	});

	it("每个仓库最多保留 10 个镜像", () => {
		const repos = Object.values(template.findResources("AWS::ECR::Repository"));
		for (const repo of repos) {
			const policy = repo.Properties?.LifecyclePolicy;
			expect(policy).toBeDefined();
			const rules = JSON.parse(policy.LifecyclePolicyText).rules as Array<
				Record<string, unknown>
			>;
			const countRule = rules.find(
				(r) =>
					r.selection &&
					(r.selection as Record<string, unknown>).countType ===
						"imageCountMoreThan",
			);
			expect(countRule).toBeDefined();
			expect(
				(countRule?.selection as Record<string, unknown>)?.countNumber,
			).toBeLessThanOrEqual(10);
		}
	});
});
