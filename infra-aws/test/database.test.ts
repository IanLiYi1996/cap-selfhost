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

describe("Database", () => {
	it("是 Aurora MySQL Serverless v2，容量 0.5 到 4 ACU", () => {
		template.hasResourceProperties("AWS::RDS::DBCluster", {
			Engine: "aurora-mysql",
			ServerlessV2ScalingConfiguration: {
				MinCapacity: 0.5,
				MaxCapacity: 4,
			},
		});
	});

	it("集群实例不可公网访问", () => {
		const instances = Object.values(
			template.findResources("AWS::RDS::DBInstance"),
		);
		expect(instances.length).toBeGreaterThan(0);
		for (const instance of instances) {
			expect(instance.Properties?.PubliclyAccessible).not.toBe(true);
		}
	});

	it("强制 TLS 连接", () => {
		template.hasResourceProperties("AWS::RDS::DBClusterParameterGroup", {
			Parameters: { require_secure_transport: "ON" },
		});
	});

	it("存储加密且保留 7 天备份", () => {
		template.hasResourceProperties("AWS::RDS::DBCluster", {
			StorageEncrypted: true,
			BackupRetentionPeriod: 7,
		});
	});

	it("建了应用需要的七个 secret", () => {
		// 3 generated (AppSecrets: NextAuth, DatabaseEncryptionKey, MediaServerWebhookSecret)
		// + 2 shells populated post-deploy (AppSecrets: CloudFrontPrivateKey, DatabaseUrl)
		// + 1 Aurora auto-generated credentials (Database)
		// + 1 Cognito app-client secret (Auth)
		template.resourceCountIs("AWS::SecretsManager::Secret", 7);
	});
});
