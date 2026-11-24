import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";

export interface DatabaseProps {
	readonly vpc: ec2.Vpc;
}

export class Database extends Construct {
	readonly cluster: rds.DatabaseCluster;
	readonly securityGroup: ec2.SecurityGroup;

	constructor(scope: Construct, id: string, props: DatabaseProps) {
		super(scope, id);

		this.securityGroup = new ec2.SecurityGroup(this, "Sg", {
			vpc: props.vpc,
			description: "Aurora, reachable only from Fargate tasks",
			allowAllOutbound: false,
		});

		const engine = rds.DatabaseClusterEngine.auroraMysql({
			version: rds.AuroraMysqlEngineVersion.VER_3_08_0,
		});

		const parameterGroup = new rds.ParameterGroup(this, "ClusterParams", {
			engine,
			parameters: { require_secure_transport: "ON" },
		});

		this.cluster = new rds.DatabaseCluster(this, "Cluster", {
			engine,
			vpc: props.vpc,
			vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
			securityGroups: [this.securityGroup],
			writer: rds.ClusterInstance.serverlessV2("Writer", {
				publiclyAccessible: false,
			}),
			serverlessV2MinCapacity: 0.5,
			serverlessV2MaxCapacity: 4,
			defaultDatabaseName: "cap",
			credentials: rds.Credentials.fromGeneratedSecret("capadmin"),
			parameterGroup,
			storageEncrypted: true,
			backup: { retention: cdk.Duration.days(7) },
			removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
		});
	}
}
