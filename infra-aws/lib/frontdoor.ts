import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";

export interface FrontDoorProps {
	readonly vpc: ec2.Vpc;
}

export class FrontDoor extends Construct {
	readonly alb: elbv2.ApplicationLoadBalancer;
	readonly listener: elbv2.ApplicationListener;
	readonly distribution: cloudfront.Distribution;

	constructor(scope: Construct, id: string, props: FrontDoorProps) {
		super(scope, id);

		const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSg", {
			vpc: props.vpc,
			description: "Internal ALB fronted by CloudFront VPC origin",
			allowAllOutbound: true,
		});

		// VPC origin traffic arrives from an AWS-managed SG ("CloudFront-VPCOrigins-Service-SG")
		// that CloudFront attaches to ENIs placed in this VPC. A VPC-CIDR rule silently yields
		// 504s — the rule must reference that service SG directly. Find its ID with:
		//   aws ec2 describe-security-groups \
		//     --filters Name=group-name,Values=CloudFront-VPCOrigins-Service-SG \
		//     --query 'SecurityGroups[0].GroupId'
		// then redeploy with: cdk deploy -c cfVpcOriginSgId=<id>
		const cfVpcOriginSgId = this.node.tryGetContext("cfVpcOriginSgId");
		if (cfVpcOriginSgId) {
			albSecurityGroup.addIngressRule(
				ec2.Peer.securityGroupId(cfVpcOriginSgId),
				ec2.Port.tcp(80),
				"CloudFront VPC origins service SG",
			);
		} else {
			cdk.Annotations.of(this).addWarning(
				"cfVpcOriginSgId context is not set — the distribution will return 504 until the " +
					"stack is redeployed with -c cfVpcOriginSgId=<id>. Find the id with: " +
					"aws ec2 describe-security-groups --filters Name=group-name,Values=CloudFront-VPCOrigins-Service-SG " +
					"--query 'SecurityGroups[0].GroupId'",
			);
		}

		this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
			vpc: props.vpc,
			internetFacing: false,
			securityGroup: albSecurityGroup,
			vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
			// 与 packages/database/auth/auth-options.ts:20 的 maxDuration = 120
			// 对齐，登录流程需要这么长
			idleTimeout: cdk.Duration.seconds(120),
		});

		this.listener = this.alb.addListener("Http", {
			port: 80,
			open: false,
			protocol: elbv2.ApplicationProtocol.HTTP,
			defaultAction: elbv2.ListenerAction.fixedResponse(503, {
				contentType: "text/plain",
				messageBody: "No target registered",
			}),
		});

		this.distribution = new cloudfront.Distribution(this, "App", {
			defaultBehavior: {
				origin: origins.VpcOrigin.withApplicationLoadBalancer(this.alb, {
					protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
					// 60 秒是 CloudFront 对 origin 读超时的上限
					readTimeout: cdk.Duration.seconds(60),
				}),
				viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
				cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
				originRequestPolicy:
					cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
			},
		});
	}

	get appUrl(): string {
		return `https://${this.distribution.distributionDomainName}`;
	}
}
