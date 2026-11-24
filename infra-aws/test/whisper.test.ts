import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	process.env.CAP_CLOUDFRONT_PUBLIC_KEY = [
		"-----BEGIN PUBLIC KEY-----",
		"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest",
		"-----END PUBLIC KEY-----",
	].join("\n");

	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

describe("WhisperTask", () => {
	it("建第三个 task definition，但不建第三个 service（按需 RunTask）", () => {
		template.resourceCountIs("AWS::ECS::TaskDefinition", 3);
		template.resourceCountIs("AWS::ECS::Service", 2);
	});

	it("规格为 4 vCPU / 8 GB", () => {
		template.hasResourceProperties("AWS::ECS::TaskDefinition", {
			Cpu: "4096",
			Memory: "8192",
		});
	});

	it("容器名必须是 whisper（RunTask 的 containerOverrides 按名字匹配）", () => {
		const json = JSON.stringify(
			Object.values(template.findResources("AWS::ECS::TaskDefinition")),
		);
		expect(json).toContain('"Name":"whisper"');
	});

	it("cap-web 的 Task Role 能 RunTask 并 PassRole", () => {
		const json = JSON.stringify(
			Object.values(template.findResources("AWS::IAM::Policy")),
		);
		expect(json).toContain("ecs:RunTask");
		expect(json).toContain("iam:PassRole");
	});
});
