import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export class Network extends Construct {
	readonly vpc: ec2.Vpc;

	constructor(scope: Construct, id: string) {
		super(scope, id);

		this.vpc = new ec2.Vpc(this, "Vpc", {
			ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
			maxAzs: 2,
			natGateways: 1,
			subnetConfiguration: [
				{
					name: "public",
					subnetType: ec2.SubnetType.PUBLIC,
					cidrMask: 24,
				},
				{
					name: "private",
					subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
					cidrMask: 20,
				},
			],
		});

		this.vpc.addGatewayEndpoint("S3Endpoint", {
			service: ec2.GatewayVpcEndpointAwsService.S3,
		});
	}
}
