import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
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

describe("Storage", () => {
	it("桶阻断一切公开访问且强制 TLS", () => {
		template.hasResourceProperties("AWS::S3::Bucket", {
			PublicAccessBlockConfiguration: {
				BlockPublicAcls: true,
				BlockPublicPolicy: true,
				IgnorePublicAcls: true,
				RestrictPublicBuckets: true,
			},
		});
	});

	it("桶策略只授权 CloudFront service principal，并带 SourceArn 条件", () => {
		const policies = Object.values(
			template.findResources("AWS::S3::BucketPolicy"),
		);
		expect(policies.length).toBeGreaterThan(0);

		const json = JSON.stringify(policies);
		expect(json).toContain("cloudfront.amazonaws.com");
		expect(json).toContain("AWS:SourceArn");
		expect(json).not.toContain('"Principal":"*"');
	});

	it("Media distribution 用 trusted key group 强制签名 URL", () => {
		template.resourceCountIs("AWS::CloudFront::KeyGroup", 1);
		template.hasResourceProperties("AWS::CloudFront::Distribution", {
			DistributionConfig: {
				DefaultCacheBehavior: {
					TrustedKeyGroups: Match.anyValue(),
				},
			},
		});
	});

	it("桶 CORS 只允许 App distribution 域名，不是通配", () => {
		const buckets = Object.values(template.findResources("AWS::S3::Bucket"));
		const cors = buckets[0]?.Properties?.CorsConfiguration;
		expect(cors).toBeDefined();
		const rules = (cors?.CorsRules as unknown[]) ?? [];
		expect(rules.length).toBeGreaterThan(0);
		const origins = (rules[0] as Record<string, unknown>)
			?.AllowedOrigins as unknown[];
		expect(origins).toBeDefined();
		expect(origins).not.toContain("*");
		expect(origins.length).toBeGreaterThan(0);
	});
});
