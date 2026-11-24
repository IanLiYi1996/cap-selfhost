import * as cdk from "aws-cdk-lib";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

const app = new cdk.App();

new CapStack(app, "CapStack", {
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: CONFIG.region,
	},
});
