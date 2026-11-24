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

describe("Auth", () => {
	it("建一个以邮箱登录、自助验证邮箱的 user pool", () => {
		template.hasResourceProperties("AWS::Cognito::UserPool", {
			UsernameAttributes: ["email"],
			AutoVerifiedAttributes: ["email"],
		});
	});

	it("app client 带 secret 且只开 authorization code flow", () => {
		template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
			GenerateSecret: true,
			AllowedOAuthFlows: ["code"],
		});
	});

	it("回调 URL 指向 NextAuth 的 oidc callback 路径", () => {
		const clients = Object.values(
			template.findResources("AWS::Cognito::UserPoolClient"),
		);
		const json = JSON.stringify(clients);
		expect(json).toContain("/api/auth/callback/oidc");
		expect(json).not.toContain("/api/auth/callback/cognito");
	});

	it("有 hosted UI 域名", () => {
		template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
	});

	it("禁止自助注册，只允许管理员创建用户", () => {
		template.hasResourceProperties("AWS::Cognito::UserPool", {
			AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
		});
	});
});
