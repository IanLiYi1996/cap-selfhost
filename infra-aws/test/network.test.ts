import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, it } from "vitest";
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

describe("Network", () => {
	it("建一个双 AZ 的 VPC", () => {
		template.resourceCountIs("AWS::EC2::VPC", 1);
		// 2 AZ × (public + private) = 4 个子网
		template.resourceCountIs("AWS::EC2::Subnet", 4);
	});

	it("只用一个 NAT Gateway（AZ 冗余不值这个成本）", () => {
		template.resourceCountIs("AWS::EC2::NatGateway", 1);
	});

	it("有 S3 Gateway Endpoint，让视频字节不走 NAT", () => {
		template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
			VpcEndpointType: "Gateway",
			ServiceName: {
				"Fn::Join": ["", ["com.amazonaws.", { Ref: "AWS::Region" }, ".s3"]],
			},
		});
	});
});
