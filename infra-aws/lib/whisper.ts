import * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { CONFIG } from "./config.js";

export interface WhisperTaskProps {
	readonly vpc: ec2.Vpc;
	readonly bucket: s3.Bucket;
	readonly repository: ecr.Repository;
	/** cap-web の Task Role，需要被授予 RunTask/PassRole */
	readonly callerRole: iam.Role;
}

export class WhisperTask extends Construct {
	readonly taskDefinition: ecs.FargateTaskDefinition;
	readonly securityGroup: ec2.SecurityGroup;

	constructor(scope: Construct, id: string, props: WhisperTaskProps) {
		super(scope, id);

		this.securityGroup = new ec2.SecurityGroup(this, "Sg", {
			vpc: props.vpc,
			description: "On-demand whisper task; egress only",
			allowAllOutbound: true,
		});

		this.taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
			cpu: 4096,
			memoryLimitMiB: 8192,
		});

		props.bucket.grantReadWrite(this.taskDefinition.taskRole);

		// The container name is part of the contract: startWhisperTask sends
		// containerOverrides keyed by this exact name.
		this.taskDefinition.addContainer("whisper", {
			image: ecs.ContainerImage.fromEcrRepository(props.repository, "latest"),
			logging: ecs.LogDrivers.awsLogs({
				streamPrefix: "cap-whisper",
				logRetention: logs.RetentionDays.ONE_MONTH,
			}),
			environment: { WHISPER_MODEL: CONFIG.whisperModel },
		});

		props.callerRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ["ecs:RunTask"],
				resources: [this.taskDefinition.taskDefinitionArn],
			}),
		);
		props.callerRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ["iam:PassRole"],
				resources: [
					this.taskDefinition.taskRole.roleArn,
					this.taskDefinition.obtainExecutionRole().roleArn,
				],
				conditions: {
					StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
				},
			}),
		);
	}
}
