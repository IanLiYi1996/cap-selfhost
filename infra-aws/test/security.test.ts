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

const resourcesOfType = (type: string) =>
	Object.values(template.findResources(type));

describe("安全基线", () => {
	it("每个 S3 桶都完全阻断公开访问", () => {
		for (const bucket of resourcesOfType("AWS::S3::Bucket")) {
			expect(bucket.Properties?.PublicAccessBlockConfiguration).toEqual({
				BlockPublicAcls: true,
				BlockPublicPolicy: true,
				IgnorePublicAcls: true,
				RestrictPublicBuckets: true,
			});
		}
	});

	it("没有任何资源策略把 Principal 设为通配 *", () => {
		const isWildcard = (p: unknown): boolean =>
			p === "*" ||
			(typeof p === "object" &&
				p !== null &&
				(p as Record<string, unknown>).AWS === "*");

		// Statement-based policies: Deny statements are legitimate hardening and are excluded.
		const statementTypes = [
			"AWS::S3::BucketPolicy",
			"AWS::SQS::QueuePolicy",
			"AWS::SNS::TopicPolicy",
			"AWS::IAM::Role",
		];
		for (const type of statementTypes) {
			for (const resource of resourcesOfType(type)) {
				const props = resource.Properties ?? {};
				const policyDoc =
					(props.PolicyDocument as Record<string, unknown> | undefined) ??
					(props.AssumeRolePolicyDocument as
						| Record<string, unknown>
						| undefined);
				const raw = policyDoc?.Statement;
				const stmts = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<
					Record<string, unknown>
				>;
				for (const stmt of stmts) {
					if (stmt.Effect !== "Deny") {
						expect(isWildcard(stmt.Principal)).toBe(false);
					}
				}
			}
		}

		// Lambda Permission: Principal is a direct grant with no Effect field.
		for (const resource of resourcesOfType("AWS::Lambda::Permission")) {
			const props = resource.Properties ?? {};
			expect(isWildcard(props.Principal)).toBe(false);
		}
	});

	it("数据库集群不可公网访问", () => {
		for (const instance of resourcesOfType("AWS::RDS::DBInstance")) {
			expect(instance.Properties?.PubliclyAccessible).not.toBe(true);
		}
	});

	it("没有 SG 入站规则放通公网地址（0.0.0.0/0 或 ::/0）", () => {
		const ingressRules = [
			...resourcesOfType("AWS::EC2::SecurityGroupIngress"),
			...resourcesOfType("AWS::EC2::SecurityGroup").flatMap(
				(sg) => (sg.Properties?.SecurityGroupIngress as unknown[]) ?? [],
			),
		] as Array<Record<string, unknown>>;

		for (const rule of ingressRules) {
			const props = (rule.Properties ?? rule) as Record<string, unknown>;
			expect(props.CidrIp).not.toBe("0.0.0.0/0");
			expect(props.CidrIpv6).not.toBe("::/0");
		}
	});

	it("task definition 里不出现明文 AWS 凭据", () => {
		for (const taskDef of resourcesOfType("AWS::ECS::TaskDefinition")) {
			const json = JSON.stringify(taskDef.Properties ?? {});
			expect(json).not.toContain("CAP_AWS_ACCESS_KEY");
			expect(json).not.toContain("CAP_AWS_SECRET_KEY");
		}
	});

	it("Lambda Function URL 不允许匿名调用", () => {
		for (const url of resourcesOfType("AWS::Lambda::Url")) {
			expect(url.Properties?.AuthType).not.toBe("NONE");
		}
	});

	it("没有 iam:PassRole 语句把 Resource 设为通配 *", () => {
		const allStmts: Array<Record<string, unknown>> = [];

		for (const policy of resourcesOfType("AWS::IAM::Policy")) {
			const raw = (
				policy.Properties?.PolicyDocument as Record<string, unknown> | undefined
			)?.Statement;
			const stmts = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<
				Record<string, unknown>
			>;
			allStmts.push(...stmts);
		}

		for (const role of resourcesOfType("AWS::IAM::Role")) {
			const inlinePolicies =
				(role.Properties?.Policies as
					| Array<Record<string, unknown>>
					| undefined) ?? [];
			for (const p of inlinePolicies) {
				const raw = (p.PolicyDocument as Record<string, unknown> | undefined)
					?.Statement;
				const stmts = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<
					Record<string, unknown>
				>;
				allStmts.push(...stmts);
			}
		}

		for (const stmt of allStmts) {
			const actions = Array.isArray(stmt.Action)
				? (stmt.Action as string[])
				: [stmt.Action as string];
			const hasPassRole = actions.some((a) => a === "iam:PassRole");
			if (hasPassRole) {
				const resources = Array.isArray(stmt.Resource)
					? (stmt.Resource as unknown[])
					: [stmt.Resource];
				for (const r of resources) {
					expect(r).not.toBe("*");
				}
			}
		}
	});

	it("ECS 服务显式禁用公网 IP 且只部署在私有子网", () => {
		const subnetMap = template.findResources("AWS::EC2::Subnet");

		for (const svc of resourcesOfType("AWS::ECS::Service")) {
			const awsvpc = svc.Properties?.NetworkConfiguration
				?.AwsvpcConfiguration as Record<string, unknown> | undefined;

			expect(awsvpc?.AssignPublicIp).toBe("DISABLED");

			const subnets = (awsvpc?.Subnets as Array<{ Ref?: string }>) ?? [];
			for (const subnetRef of subnets) {
				const logicalId = subnetRef.Ref;
				expect(logicalId).toBeDefined();
				const subnet = subnetMap[logicalId as string];
				expect(subnet).toBeDefined();
				expect(subnet.Properties?.MapPublicIpOnLaunch).not.toBe(true);
			}
		}
	});
});
