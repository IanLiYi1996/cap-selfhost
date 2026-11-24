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

describe("FrontDoor", () => {
	it("ALB 是 internal，不是 internet-facing", () => {
		template.hasResourceProperties(
			"AWS::ElasticLoadBalancingV2::LoadBalancer",
			{
				Scheme: "internal",
			},
		);
	});

	it("建了 CloudFront VPC origin 而非公网 origin", () => {
		template.resourceCountIs("AWS::CloudFront::VpcOrigin", 1);
	});

	it("CloudFront 强制 HTTPS 并允许所有方法（上传/表单需要 POST）", () => {
		template.hasResourceProperties("AWS::CloudFront::Distribution", {
			DistributionConfig: {
				DefaultCacheBehavior: {
					ViewerProtocolPolicy: "redirect-to-https",
				},
			},
		});
	});

	it("未设置 cfVpcOriginSgId 时 ALB 安全组没有 80 端口入站规则", () => {
		const sgs = Object.values(
			template.findResources("AWS::EC2::SecurityGroup"),
		);
		for (const sg of sgs) {
			const ingress = (sg.Properties?.SecurityGroupIngress as unknown[]) ?? [];
			for (const rule of ingress) {
				const r = rule as Record<string, unknown>;
				expect(Number(r.FromPort)).not.toBe(80);
			}
		}
	});
});

describe("FrontDoor（设置 cfVpcOriginSgId）", () => {
	let templateWithCtx: Template;

	beforeAll(() => {
		const app = new cdk.App({
			context: { cfVpcOriginSgId: "sg-0123456789abcdef0" },
		});
		const stack = new CapStack(app, "TestStackCtx", {
			env: { account: "123456789012", region: CONFIG.region },
		});
		templateWithCtx = Template.fromStack(stack);
	});

	it("ALB SG 有源自 CloudFront service SG 的 80 端口入站规则", () => {
		templateWithCtx.hasResourceProperties("AWS::EC2::SecurityGroup", {
			SecurityGroupIngress: Match.arrayWith([
				Match.objectLike({
					FromPort: 80,
					ToPort: 80,
					SourceSecurityGroupId: "sg-0123456789abcdef0",
				}),
			]),
		});
	});

	it("ALB SG 的 80 端口入站规则无 CidrIp", () => {
		const sgs = Object.values(
			templateWithCtx.findResources("AWS::EC2::SecurityGroup"),
		);
		for (const sg of sgs) {
			const ingress = (sg.Properties?.SecurityGroupIngress as unknown[]) ?? [];
			for (const rule of ingress) {
				const r = rule as Record<string, unknown>;
				if (Number(r.FromPort) === 80) {
					expect(r.CidrIp).toBeUndefined();
					expect(r.CidrIpv6).toBeUndefined();
				}
			}
		}
	});
});
