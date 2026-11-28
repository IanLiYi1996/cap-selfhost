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

const taskDefs = () =>
	Object.values(template.findResources("AWS::ECS::TaskDefinition"));

describe("Compute", () => {
	it("建两个 Fargate 服务", () => {
		template.resourceCountIs("AWS::ECS::Service", 2);
	});

	it("cap-web 在 media-server 之后创建（Service Connect 端点在 deployment 创建时固定）", () => {
		const services = template.findResources("AWS::ECS::Service");
		const id = (prefix: string) => {
			const found = Object.keys(services).find((key) => key.startsWith(prefix));
			expect(found).toBeDefined();
			return found as string;
		};
		const web = services[id("ComputeWebService")];
		const dependsOn = [web.DependsOn ?? []].flat();
		expect(dependsOn).toContain(id("ComputeMediaService"));
	});

	it("知识库向量桶只授权给任务角色，且限定在该向量桶内", () => {
		template.resourceCountIs("AWS::S3Vectors::VectorBucket", 1);
		const statements = Object.values(
			template.findResources("AWS::IAM::Policy"),
		).flatMap(
			(policy) =>
				(policy.Properties.PolicyDocument.Statement ?? []) as {
					Action: string | string[];
					Resource: unknown;
				}[],
		);
		const vectorStatements = statements.filter((statement) =>
			[statement.Action]
				.flat()
				.some((action) => action.startsWith("s3vectors:")),
		);
		expect(vectorStatements).toHaveLength(1);
		const resources = [vectorStatements[0]?.Resource].flat();
		expect(resources).not.toContain("*");
		expect(resources).toHaveLength(2);
		const env = taskDefs()
			.flatMap(
				(def) =>
					def.Properties.ContainerDefinitions[0].Environment as {
						Name: string;
						Value: unknown;
					}[],
			)
			.find((entry) => entry.Name === "KNOWLEDGE_VECTOR_BUCKET");
		expect(env?.Value).toBe("teststack-knowledge");
	});

	it("S3_PATH_STYLE 为 false（默认 true 是给 MinIO 的）", () => {
		const env = taskDefs()
			.flatMap(
				(def) => (def.Properties?.ContainerDefinitions as unknown[]) ?? [],
			)
			.flatMap(
				(container) =>
					((container as Record<string, unknown>).Environment as Array<{
						Name: string;
						Value: string;
					}>) ?? [],
			);
		const pathStyle = env.find((e) => e.Name === "S3_PATH_STYLE");
		expect(pathStyle?.Value).toBe("false");
	});

	it("NEXT_PUBLIC_IS_CAP 绝不出现（它会重新开启 Pro 门槛）", () => {
		expect(JSON.stringify(taskDefs())).not.toContain("NEXT_PUBLIC_IS_CAP");
	});

	it("敏感值走 secrets 注入而非明文 environment", () => {
		const SENSITIVE = [
			"NEXTAUTH_SECRET",
			"DATABASE_ENCRYPTION_KEY",
			"MEDIA_SERVER_WEBHOOK_SECRET",
			"DATABASE_URL",
			"CLOUDFRONT_KEYPAIR_PRIVATE_KEY",
			"OIDC_CLIENT_SECRET",
		];
		const containers = taskDefs().flatMap(
			(def) =>
				(def.Properties?.ContainerDefinitions as Array<
					Record<string, unknown>
				>) ?? [],
		);
		for (const container of containers) {
			const env = (container.Environment as Array<{ Name: string }>) ?? [];
			for (const name of SENSITIVE) {
				expect(env.map((e) => e.Name)).not.toContain(name);
			}
		}
		const allSecrets = containers.flatMap(
			(c) => (c.Secrets as Array<{ Name: string; ValueFrom: unknown }>) ?? [],
		);
		for (const name of SENSITIVE) {
			const found = allSecrets.find((s) => s.Name === name);
			expect(found?.ValueFrom, `${name} missing ValueFrom`).toBeDefined();
		}
	});

	it("cap-web 在 Service Connect 发布 DNS 名，media-server 能回调", () => {
		const services = Object.values(template.findResources("AWS::ECS::Service"));
		const dnsNames = services
			.flatMap(
				(svc) =>
					((
						svc.Properties?.ServiceConnectConfiguration as Record<
							string,
							unknown
						>
					)?.Services as unknown[]) ?? [],
			)
			.flatMap(
				(s) =>
					((s as Record<string, unknown>).ClientAliases as Array<{
						DnsName: string;
					}>) ?? [],
			)
			.map((alias) => alias.DnsName);
		expect(dnsNames).toContain("cap-web");

		const ingressResources = Object.values(
			template.findResources("AWS::EC2::SecurityGroupIngress"),
		).map((r) => r.Properties as Record<string, unknown>);
		const webPortRules = ingressResources.filter(
			(r) => Number(r.FromPort) === 3000 && Number(r.ToPort) === 3000,
		);
		expect(webPortRules.length).toBeGreaterThan(0);
	});

	it("Task Role 能读写桶并调 Bedrock", () => {
		const json = JSON.stringify(
			Object.values(template.findResources("AWS::IAM::Policy")),
		);
		expect(json).toContain("s3:PutObject");
		expect(json).toContain("bedrock:InvokeModel");
	});

	it("OIDC_CLIENT_SECRET 通过 Secrets Manager 注入 cap-web（而非明文环境变量）", () => {
		const containers = taskDefs().flatMap(
			(def) =>
				(def.Properties?.ContainerDefinitions as Array<
					Record<string, unknown>
				>) ?? [],
		);
		const allSecrets = containers.flatMap(
			(c) => (c.Secrets as Array<{ Name: string; ValueFrom: unknown }>) ?? [],
		);
		const found = allSecrets.find((s) => s.Name === "OIDC_CLIENT_SECRET");
		expect(
			found?.ValueFrom,
			"OIDC_CLIENT_SECRET missing ValueFrom",
		).toBeDefined();
	});

	it("cap-web 有 AI_PROVIDER=bedrock 和 BEDROCK_REGION=stack region（Bedrock 必须显式开启）", () => {
		const env = taskDefs()
			.flatMap(
				(def) => (def.Properties?.ContainerDefinitions as unknown[]) ?? [],
			)
			.flatMap(
				(container) =>
					((container as Record<string, unknown>).Environment as Array<{
						Name: string;
						Value: string;
					}>) ?? [],
			);
		const aiProvider = env.find((e) => e.Name === "AI_PROVIDER");
		expect(aiProvider?.Value).toBe("bedrock");
		const bedrockRegion = env.find((e) => e.Name === "BEDROCK_REGION");
		expect(bedrockRegion?.Value).toBe(CONFIG.region);
	});

	it("cap-web 要求登录才能看视频（CAP_REQUIRE_SIGN_IN_TO_VIEW=true）", () => {
		const env = taskDefs()
			.flatMap(
				(def) => (def.Properties?.ContainerDefinitions as unknown[]) ?? [],
			)
			.flatMap(
				(container) =>
					((container as Record<string, unknown>).Environment as Array<{
						Name: string;
						Value: unknown;
					}>) ?? [],
			);
		expect(
			env.find((e) => e.Name === "CAP_REQUIRE_SIGN_IN_TO_VIEW")?.Value,
		).toBe("true");
	});

	it("cap-web 用 Amazon Transcribe 转写，并有提交/查询/删除任务的权限", () => {
		const env = taskDefs()
			.flatMap(
				(def) => (def.Properties?.ContainerDefinitions as unknown[]) ?? [],
			)
			.flatMap(
				(container) =>
					((container as Record<string, unknown>).Environment as Array<{
						Name: string;
						Value: unknown;
					}>) ?? [],
			);
		expect(env.find((e) => e.Name === "TRANSCRIPTION_BACKEND")?.Value).toBe(
			"transcribe",
		);
		expect(
			env.find((e) => e.Name === "TRANSCRIBE_LANGUAGE_OPTIONS")?.Value,
		).toBe("zh-CN,en-US");

		type Statement = {
			Action: string | string[];
			Resource: unknown;
			Condition?: Record<string, Record<string, unknown>>;
		};
		const statements = Object.values(
			template.findResources("AWS::IAM::Policy"),
		).flatMap(
			(policy) =>
				(policy.Properties?.PolicyDocument?.Statement as Statement[]) ?? [],
		);
		const grants = (action: string) =>
			statements.filter((s) =>
				(Array.isArray(s.Action) ? s.Action : [s.Action]).includes(action),
			);

		// StartTranscriptionJob has no resource type, so it can only be scoped by
		// condition: to writing output into the recordings bucket.
		const [start] = grants("transcribe:StartTranscriptionJob");
		expect(start?.Resource).toBe("*");
		expect(
			start?.Condition?.StringEquals?.["transcribe:OutputBucketName"],
		).toBeDefined();

		for (const action of [
			"transcribe:GetTranscriptionJob",
			"transcribe:DeleteTranscriptionJob",
		]) {
			const [grant] = grants(action);
			expect(JSON.stringify(grant?.Resource)).toContain(
				"transcription-job/cap-*",
			);
		}
	});

	it("cap-web 放行 Chrome 商店版插件登录（CAP_CHROME_EXTENSION_ID）", () => {
		const env = taskDefs()
			.flatMap(
				(def) => (def.Properties?.ContainerDefinitions as unknown[]) ?? [],
			)
			.flatMap(
				(container) =>
					((container as Record<string, unknown>).Environment as Array<{
						Name: string;
						Value: unknown;
					}>) ?? [],
			);
		expect(env.find((e) => e.Name === "CAP_CHROME_EXTENSION_ID")?.Value).toBe(
			"fefjaffcodfiogbbngmjkcjpbpclbdcp",
		);
	});

	it("cap-web 用上游的通用 OIDC 对接 Cognito，不再设置 COGNITO_*", () => {
		const env = taskDefs()
			.flatMap(
				(def) => (def.Properties?.ContainerDefinitions as unknown[]) ?? [],
			)
			.flatMap(
				(container) =>
					((container as Record<string, unknown>).Environment as Array<{
						Name: string;
						Value: unknown;
					}>) ?? [],
			);
		const names = env.map((e) => e.Name);
		expect(names).toContain("OIDC_ISSUER");
		expect(names).toContain("OIDC_CLIENT_ID");
		expect(names.filter((n) => n.startsWith("COGNITO_"))).toEqual([]);
	});

	it("cap-web 容器的环境变量包含全部四个 WHISPER_* 配置（缺任一则 isWhisperConfigured 返回 false）", () => {
		const webDef = taskDefs().find((def) => {
			const containers =
				(def.Properties?.ContainerDefinitions as Array<
					Record<string, unknown>
				>) ?? [];
			return containers.some((c) => (c.Name as string | undefined) === "web");
		});
		const env =
			((
				(webDef?.Properties?.ContainerDefinitions as Array<
					Record<string, unknown>
				>) ?? []
			).find((c) => (c.Name as string | undefined) === "web")
				?.Environment as Array<{ Name: string }>) ?? [];
		const names = env.map((e) => e.Name);
		expect(names).toContain("WHISPER_CLUSTER_ARN");
		expect(names).toContain("WHISPER_TASK_DEFINITION_ARN");
		expect(names).toContain("WHISPER_SUBNET_IDS");
		expect(names).toContain("WHISPER_SECURITY_GROUP_ID");
	});

	it("target group health check 接受 200-399（/ 对未认证请求返回 307）", () => {
		const tgs = Object.values(
			template.findResources("AWS::ElasticLoadBalancingV2::TargetGroup"),
		);
		const matchers = tgs
			.map(
				(tg) => (tg.Properties?.Matcher as Record<string, unknown>)?.HttpCode,
			)
			.filter(Boolean);
		expect(matchers).toContain("200-399");
	});
});

describe("skipTasks flag", () => {
	let flaggedTemplate: Template;

	beforeAll(() => {
		const app = new cdk.App({ context: { skipTasks: "true" } });
		const stack = new CapStack(app, "FlaggedStack", {
			env: { account: "123456789012", region: CONFIG.region },
		});
		flaggedTemplate = Template.fromStack(stack);
	});

	it("默认（无 flag）：两个服务的 DesiredCount 均为 1", () => {
		const services = Object.values(template.findResources("AWS::ECS::Service"));
		expect(services).toHaveLength(2);
		for (const svc of services) {
			expect(svc.Properties?.DesiredCount).toBe(1);
		}
	});

	it("skipTasks=true：两个服务的 DesiredCount 均为 0（首次 deploy 无镜像时避免回滚）", () => {
		const services = Object.values(
			flaggedTemplate.findResources("AWS::ECS::Service"),
		);
		expect(services).toHaveLength(2);
		for (const svc of services) {
			expect(svc.Properties?.DesiredCount).toBe(0);
		}
	});
});
