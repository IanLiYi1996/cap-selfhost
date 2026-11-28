import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { Auth } from "./auth.js";
import type { Database } from "./database.js";
import type { AppSecrets } from "./secrets.js";
import type { Storage } from "./storage.js";

const NAMESPACE = "cap.local";
const MEDIA_SERVER_DNS = "media-server";
const MEDIA_SERVER_PORT = 3456;
const WEB_PORT = 3000;

export interface ComputeProps {
	readonly vpc: ec2.Vpc;
	readonly listener: elbv2.ApplicationListener;
	readonly appUrl: string;
	readonly storage: Storage;
	readonly database: Database;
	readonly secrets: AppSecrets;
	readonly auth: Auth;
	readonly webRepository: ecr.Repository;
	readonly mediaServerRepository: ecr.Repository;
}

export class Compute extends Construct {
	readonly cluster: ecs.Cluster;
	readonly taskRole: iam.Role;
	readonly webContainer: ecs.ContainerDefinition;
	readonly webService: ecs.FargateService;
	readonly mediaService: ecs.FargateService;

	constructor(scope: Construct, id: string, props: ComputeProps) {
		super(scope, id);

		// 首次 deploy 时 ECR 仓库为空：镜像 URI 要等本次 deploy 写出 outputs.json
		// 后才能被构建脚本读到，而 ECS 服务等待健康任务会先超时并回滚。
		// 用 -c skipTasks=true 将两个服务的 desiredCount 设为 0，让 stack 在
		// 无镜像时成功建成；镜像推送后不带该 flag 再次 deploy 即可扩容至 1。
		const skipTasks = this.node.tryGetContext("skipTasks") === "true";

		this.cluster = new ecs.Cluster(this, "Cluster", {
			vpc: props.vpc,
			containerInsightsV2: ecs.ContainerInsights.ENABLED,
			defaultCloudMapNamespace: {
				name: NAMESPACE,
				useForServiceConnect: true,
			},
		});

		this.taskRole = new iam.Role(this, "TaskRole", {
			assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
		});

		props.storage.bucket.grantReadWrite(this.taskRole);
		this.taskRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ["cloudfront:CreateInvalidation"],
				resources: [
					cdk.Stack.of(this).formatArn({
						service: "cloudfront",
						region: "",
						resource: "distribution",
						resourceName: props.storage.distribution.distributionId,
					}),
				],
			}),
		);
		// Bedrock 现在就授权：它不依赖任何本 stack 内的资源，
		// Task 19 只改应用代码，不必回来动 IAM。
		this.taskRole.addToPolicy(
			new iam.PolicyStatement({
				actions: [
					"bedrock:InvokeModel",
					"bedrock:InvokeModelWithResponseStream",
				],
				resources: ["*"],
			}),
		);

		// Batch transcription. StartTranscriptionJob has no resource type, so it
		// is scoped by condition to writing into the recordings bucket; the job
		// itself (named cap-<videoId>-<purpose>-v<n>) scopes Get and Delete.
		this.taskRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ["transcribe:StartTranscriptionJob"],
				resources: ["*"],
				conditions: {
					StringEquals: {
						"transcribe:OutputBucketName": props.storage.bucket.bucketName,
					},
				},
			}),
		);
		this.taskRole.addToPolicy(
			new iam.PolicyStatement({
				actions: [
					"transcribe:GetTranscriptionJob",
					"transcribe:DeleteTranscriptionJob",
				],
				resources: [
					cdk.Stack.of(this).formatArn({
						service: "transcribe",
						resource: "transcription-job",
						resourceName: "cap-*",
					}),
				],
			}),
		);
		// Live captions: Transcribe Streaming on the media server, Translate on
		// the web app. Neither action has a resource type to scope by.
		this.taskRole.addToPolicy(
			new iam.PolicyStatement({
				actions: [
					"transcribe:StartStreamTranscription",
					"translate:TranslateText",
					// Translate's "auto" source language asks Comprehend.
					"comprehend:DetectDominantLanguage",
				],
				resources: ["*"],
			}),
		);

		// The knowledge index: the app creates its index on first use, then reads
		// and writes vectors in it.
		this.taskRole.addToPolicy(
			new iam.PolicyStatement({
				actions: [
					"s3vectors:GetIndex",
					"s3vectors:CreateIndex",
					"s3vectors:PutVectors",
					"s3vectors:GetVectors",
					"s3vectors:QueryVectors",
					"s3vectors:DeleteVectors",
					"s3vectors:ListVectors",
				],
				resources: [
					props.storage.vectorBucketArn,
					`${props.storage.vectorBucketArn}/index/*`,
				],
			}),
		);

		const webSecurityGroup = new ec2.SecurityGroup(this, "WebSg", {
			vpc: props.vpc,
			allowAllOutbound: true,
		});
		const mediaSecurityGroup = new ec2.SecurityGroup(this, "MediaSg", {
			vpc: props.vpc,
			allowAllOutbound: true,
		});

		props.database.securityGroup.addIngressRule(
			webSecurityGroup,
			ec2.Port.tcp(3306),
			"cap-web to Aurora",
		);

		const commonSecrets = {
			NEXTAUTH_SECRET: ecs.Secret.fromSecretsManager(
				props.secrets.nextAuthSecret,
			),
			DATABASE_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(
				props.secrets.databaseEncryptionKey,
			),
			MEDIA_SERVER_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(
				props.secrets.mediaServerWebhookSecret,
			),
		};

		const webTask = new ecs.FargateTaskDefinition(this, "WebTask", {
			cpu: 1024,
			memoryLimitMiB: 2048,
			taskRole: this.taskRole,
		});

		this.webContainer = webTask.addContainer("web", {
			image: ecs.ContainerImage.fromEcrRepository(
				props.webRepository,
				"latest",
			),
			logging: ecs.LogDrivers.awsLogs({
				streamPrefix: "cap-web",
				logRetention: logs.RetentionDays.ONE_MONTH,
			}),
			portMappings: [{ name: "web", containerPort: WEB_PORT }],
			environment: {
				WEB_URL: props.appUrl,
				NEXTAUTH_URL: props.appUrl,
				CAP_AWS_BUCKET: props.storage.bucket.bucketName,
				CAP_AWS_REGION: cdk.Stack.of(this).region,
				// 默认值 true 是给 MinIO 的；真 S3 需要 virtual-hosted style
				S3_PATH_STYLE: "false",
				CAP_AWS_BUCKET_URL: props.storage.bucketUrl,
				CAP_CLOUDFRONT_DISTRIBUTION_ID:
					props.storage.distribution.distributionId,
				CLOUDFRONT_KEYPAIR_ID: props.storage.keyPairId,
				MEDIA_SERVER_URL: `http://${MEDIA_SERVER_DNS}:${MEDIA_SERVER_PORT}`,
				MEDIA_SERVER_WEBHOOK_URL: `http://cap-web:${WEB_PORT}`,
				OIDC_ISSUER: props.auth.issuer,
				OIDC_CLIENT_ID: props.auth.client.userPoolClientId,
				CAP_REQUIRE_SIGN_IN_TO_VIEW: "true",
				// The Chrome Web Store build of the Cap extension. Extension sign-in
				// returns 400 for every other id, and for all ids when unset.
				CAP_CHROME_EXTENSION_ID: "fefjaffcodfiogbbngmjkcjpbpclbdcp",
				TRANSCRIPTION_BACKEND: "transcribe",
				TRANSCRIBE_LANGUAGE_OPTIONS: "zh-CN,en-US",
				LIVE_TRANSCRIBE_RUNNER: "media-server",
				LIVE_TRANSCRIBE_ASR: "aws-transcribe",
				LIVE_TRANSLATE_BACKEND: "aws-translate",
				KNOWLEDGE_VECTOR_BUCKET: props.storage.vectorBucketName,
				AI_PROVIDER: "bedrock",
				BEDROCK_REGION: cdk.Stack.of(this).region,
			},
			secrets: {
				...commonSecrets,
				DATABASE_URL: ecs.Secret.fromSecretsManager(props.secrets.databaseUrl),
				CLOUDFRONT_KEYPAIR_PRIVATE_KEY: ecs.Secret.fromSecretsManager(
					props.secrets.cloudFrontPrivateKey,
				),
				OIDC_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
					props.auth.clientSecretParameter,
				),
			},
		});

		this.webService = new ecs.FargateService(this, "WebService", {
			cluster: this.cluster,
			taskDefinition: webTask,
			desiredCount: skipTasks ? 0 : 1,
			securityGroups: [webSecurityGroup],
			vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
			serviceConnectConfiguration: {
				namespace: NAMESPACE,
				services: [
					{
						portMappingName: "web",
						dnsName: "cap-web",
						port: WEB_PORT,
					},
				],
			},
			circuitBreaker: { rollback: true },
		});

		props.listener.addTargets("WebTarget", {
			port: WEB_PORT,
			protocol: elbv2.ApplicationProtocol.HTTP,
			targets: [this.webService],
			healthCheck: {
				path: "/",
				// cap-web redirects unauthenticated requests from / to /login with 307;
				// a 200-only matcher kills every task before it can serve traffic.
				healthyHttpCodes: "200-399",
				healthyThresholdCount: 2,
				interval: cdk.Duration.seconds(30),
				timeout: cdk.Duration.seconds(10),
			},
			deregistrationDelay: cdk.Duration.seconds(30),
			priority: 1,
			conditions: [elbv2.ListenerCondition.pathPatterns(["/*"])],
		});

		const mediaTask = new ecs.FargateTaskDefinition(this, "MediaTask", {
			cpu: 2048,
			memoryLimitMiB: 4096,
			taskRole: this.taskRole,
		});

		mediaTask.addContainer("media-server", {
			image: ecs.ContainerImage.fromEcrRepository(
				props.mediaServerRepository,
				"latest",
			),
			logging: ecs.LogDrivers.awsLogs({
				streamPrefix: "cap-media-server",
				logRetention: logs.RetentionDays.ONE_MONTH,
			}),
			portMappings: [{ name: "media", containerPort: MEDIA_SERVER_PORT }],
			environment: {
				PORT: String(MEDIA_SERVER_PORT),
				AWS_REGION: cdk.Stack.of(this).region,
			},
			secrets: {
				MEDIA_SERVER_WEBHOOK_SECRET: commonSecrets.MEDIA_SERVER_WEBHOOK_SECRET,
			},
		});

		this.mediaService = new ecs.FargateService(this, "MediaService", {
			cluster: this.cluster,
			taskDefinition: mediaTask,
			desiredCount: skipTasks ? 0 : 1,
			securityGroups: [mediaSecurityGroup],
			vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
			serviceConnectConfiguration: {
				namespace: NAMESPACE,
				services: [
					{
						portMappingName: "media",
						dnsName: MEDIA_SERVER_DNS,
						port: MEDIA_SERVER_PORT,
					},
				],
			},
			circuitBreaker: { rollback: true },
		});

		// Service Connect gives a deployment only the endpoints that exist when
		// the deployment is created. This makes cap-web's first deployment see
		// media-server; media-server's calls back to cap-web (webhooks) still
		// need a later deployment, which deploy.sh rolls on the first deploy.
		this.webService.node.addDependency(this.mediaService);

		mediaSecurityGroup.addIngressRule(
			webSecurityGroup,
			ec2.Port.tcp(MEDIA_SERVER_PORT),
			"cap-web to media-server",
		);

		webSecurityGroup.addIngressRule(
			mediaSecurityGroup,
			ec2.Port.tcp(WEB_PORT),
			"media-server webhook callbacks to cap-web",
		);
	}
}
