import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { Auth } from "./auth.js";
import { Compute } from "./compute.js";
import { Database } from "./database.js";
import { FrontDoor } from "./frontdoor.js";
import { Network } from "./network.js";
import { Registry } from "./registry.js";
import { AppSecrets } from "./secrets.js";
import { Storage } from "./storage.js";
import { WhisperTask } from "./whisper.js";

export class CapStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		const network = new Network(this, "Network");
		const frontDoor = new FrontDoor(this, "FrontDoor", {
			vpc: network.vpc,
		});

		const storage = new Storage(this, "Storage", {
			appUrl: frontDoor.appUrl,
		});

		const secrets = new AppSecrets(this, "Secrets");
		const database = new Database(this, "Database", { vpc: network.vpc });
		const registry = new Registry(this, "Registry");

		const auth = new Auth(this, "Auth", {
			appUrl: frontDoor.appUrl,
			domainPrefix: `cap-${cdk.Stack.of(this).account}`,
		});

		const compute = new Compute(this, "Compute", {
			vpc: network.vpc,
			listener: frontDoor.listener,
			appUrl: frontDoor.appUrl,
			storage,
			database,
			secrets,
			auth,
			webRepository: registry.web,
			mediaServerRepository: registry.mediaServer,
		});

		const whisper = new WhisperTask(this, "Whisper", {
			vpc: network.vpc,
			bucket: storage.bucket,
			repository: registry.whisper,
			callerRole: compute.taskRole,
		});

		// 后置追加，避免 Compute ↔ WhisperTask 的循环引用
		compute.webContainer.addEnvironment(
			"WHISPER_CLUSTER_ARN",
			compute.cluster.clusterArn,
		);
		compute.webContainer.addEnvironment(
			"WHISPER_TASK_DEFINITION_ARN",
			whisper.taskDefinition.taskDefinitionArn,
		);
		compute.webContainer.addEnvironment(
			"WHISPER_SUBNET_IDS",
			network.vpc.privateSubnets.map((s) => s.subnetId).join(","),
		);
		compute.webContainer.addEnvironment(
			"WHISPER_SECURITY_GROUP_ID",
			whisper.securityGroup.securityGroupId,
		);

		new cdk.CfnOutput(this, "AppUrl", { value: frontDoor.appUrl });
		new cdk.CfnOutput(this, "BucketName", { value: storage.bucket.bucketName });
		new cdk.CfnOutput(this, "BucketUrl", { value: storage.bucketUrl });
		new cdk.CfnOutput(this, "CloudFrontKeyPairId", {
			value: storage.keyPairId,
		});
		new cdk.CfnOutput(this, "DatabaseEndpoint", {
			value: database.cluster.clusterEndpoint.hostname,
		});
		new cdk.CfnOutput(this, "DatabaseCredentialsSecretArn", {
			value: database.cluster.secret?.secretArn ?? "none",
		});
		new cdk.CfnOutput(this, "DatabaseUrlSecretArn", {
			value: secrets.databaseUrl.secretArn,
		});
		new cdk.CfnOutput(this, "CloudFrontPrivateKeySecretArn", {
			value: secrets.cloudFrontPrivateKey.secretArn,
		});
		new cdk.CfnOutput(this, "WebRepositoryUri", {
			value: registry.web.repositoryUri,
		});
		new cdk.CfnOutput(this, "MediaServerRepositoryUri", {
			value: registry.mediaServer.repositoryUri,
		});
		new cdk.CfnOutput(this, "WhisperRepositoryUri", {
			value: registry.whisper.repositoryUri,
		});
		new cdk.CfnOutput(this, "CognitoIssuer", { value: auth.issuer });
		new cdk.CfnOutput(this, "CognitoClientId", {
			value: auth.client.userPoolClientId,
		});
	}
}
